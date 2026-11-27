// Scheduled email jobs (Phase 16, Wave 9). The daily cron route's
// orchestration: outbox drain + AI re-score + AI digests + subscription
// expiry (SRC-201) + missed-notification reconciliation (DB-032 /
// EML-043). One function the thin cron route calls; every step is
// isolated, so a throwing step never cancels the others (EML-063).
// Framework-independent (no Next.js imports); only services import
// @sendcms/database.
//
// Seven admin pages, Phase C — Jobs (plan §3.6, Q8): every invocation
// writes a CronRun row (insert RUNNING at start, finish update at the
// end), the standalone worker writes a row only on failed polls, and
// the cron run itself prunes rows older than 90 days. `getLastCronRun`
// (in-memory, per serverless instance) stays as-is — it is NOT a
// substitute for the table; the Jobs page reads the table.
import { db, SubmissionStatus } from "@sendcms/database"
import type {
  CronRun,
  CronRunStatus,
  CronTrigger,
  Prisma,
} from "@sendcms/database"
import {
  enqueueSubmissionNotifications,
  processEmailOutbox,
} from "@sendcms/notifications"
import { createLogger } from "@sendcms/observability"
import { requireAdmin } from "@sendcms/permissions"
import type { AdminRole, PlatformRole } from "@sendcms/permissions"
import { expireSubscriptions } from "@sendcms/plans"
import { logAudit, requireStepUp } from "@sendcms/security"
import { ApiError } from "@sendcms/shared"
import { rescoreNewSubmissions, sendDueDigests } from "@sendcms/submissions"
import type { CronRunsQuery } from "./validators"

const logger = createLogger("cron:email-outbox")

/** Per-invocation work caps (EML-062). The outbox cap matches the
    submit route's `after()` hook (25); at ~1 s per job the five steps
    stay inside the route's `maxDuration = 60`. */
export const CRON_OUTBOX_LIMIT = 25
export const CRON_RESCORE_LIMIT = 25
export const CRON_DIGEST_LIMIT = 25
export const CRON_RECONCILE_LIMIT = 25

/** A NEW submission must be at least this old before the reconciler
    treats a missing notification job as lost (DB-032 / EML-043): the
    submit path enqueues right after the save, so anything younger
    may simply not have been enqueued yet. */
export const RECONCILE_MIN_AGE_MINUTES = 10

/** CronRun retention (Q8, owner-approved, plan §3.6): rows older than
    this are deleted by the cron run itself (`pruneOldCronRuns`).
    CronRun rows ONLY — no other table is ever auto-deleted. */
export const CRON_RUN_RETENTION_DAYS = 90

/** CronRun list paging (same bounds as the other admin lists:
    default 20, hard cap 100). */
export const CRON_RUNS_DEFAULT_PER_PAGE = 20
export const CRON_RUNS_MAX_PER_PAGE = 100

export type EmailOutboxCronResult = {
  /** Outbox drain counts (0 + `outboxError` when the step threw).
      `processed` is attempted jobs (`sent + failed`); `skipped` is
      due jobs another processor claimed first (EML-038). */
  processed: number
  sent: number
  failed: number
  skipped: number
  outboxError: string | null
  /** AI re-score counts (EML-068: `rescoreSkipped` is reported, not dropped). */
  rescored: number
  markedSpam: number
  rescoreSkipped: number
  rescoreError: string | null
  /** AI digest counts (EML-068: `digestSkipped` is reported, not dropped). */
  digests: number
  digestSkipped: number
  digestError: string | null
  /** Subscription expiry (SRC-201): due ACTIVE / TRIALING / PAST_DUE
      subscriptions past `currentPeriodEnd`, split by outcome. */
  subscriptionsExpired: number
  subscriptionsCanceled: number
  expiryError: string | null
  /** Missed-notification reconciliation (DB-032 / EML-043). */
  reconciled: number
  reconcileJobsCreated: number
  reconcileError: string | null
  /** Wall time of the whole run, and when it finished. */
  durationMs: number
  runAt: string
}

export type ReconcileResult = {
  /** NEW submissions older than the age cutoff that were examined. */
  checked: number
  /** Of those, how many had no jobs and were (re-)enqueued. */
  reconciled: number
  /** EmailJob rows created. */
  jobsCreated: number
}

/** The actor shape the CronRun services need: the admin session's id
    plus the two role fields `requireAdmin` reads. `AdminSession` is
    assignable to this (extra session fields are fine); the local type
    keeps `@sendcms/cron` free of the `@sendcms/auth` dependency. */
export type CronAdminActor = {
  user: {
    id: string
    platformRole?: PlatformRole | null
    adminRole?: AdminRole | null
  }
}

/** One step of a CronRun row's `steps` Json: the five canonical
    fields (plan §3.6). `sent` is the step's decisive completed count
    — sent emails (outbox), submissions marked spam (rescore), sent
    digests (digest), expired subscriptions (expiry), jobs created
    (reconcile) — so every number `runEmailOutboxCron()` returns is
    preserved in the row. `errors` holds the step's error message, if
    any (at most one: a step either throws once or it does not). */
export type CronRunStepSummary = {
  processed: number
  sent: number
  failed: number
  skipped: number
  errors: string[]
}

/** The `steps` Json of a CronRun row: one entry per step of
    `runEmailOutboxCron()`, keyed by step name. */
export type CronRunSteps = {
  outbox: CronRunStepSummary
  rescore: CronRunStepSummary
  digest: CronRunStepSummary
  expiry: CronRunStepSummary
  reconcile: CronRunStepSummary
}

/** The last completed cron run on this instance (EML-064). In-memory
    only: serverless isolates keep their own copy, and it is null
    before the first run — the structured log line is the durable
    record, this is the cheap status read (`/api/health` surfaces it). */
let lastRun: EmailOutboxCronResult | null = null

export function getLastCronRun(): EmailOutboxCronResult | null {
  return lastRun
}

/** One step, isolated (EML-063): a throw is logged and reported in
    the step's `error` field instead of aborting the remaining steps. */
async function runStep<T>(
  name: string,
  fn: () => Promise<T>
): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await fn(), error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    logger.error(`cron step failed: ${name}`, { error: err })
    return { value: null, error: message }
  }
}

// ─── CronRun writer (Phase C, Jobs) ────────────────────────────────────

/** A zeroed steps object: the shape a RUNNING row is inserted with,
    and the base for a run that threw before producing a result. */
export function emptyCronRunSteps(): CronRunSteps {
  const zero = (): CronRunStepSummary => ({
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  })
  return {
    outbox: zero(),
    rescore: zero(),
    digest: zero(),
    expiry: zero(),
    reconcile: zero(),
  }
}

/** The per-step breakdown of a finished run, built from the result
    the steps already return — no new queries, no recomputation. */
export function buildCronRunSteps(result: EmailOutboxCronResult): CronRunSteps {
  const step = (
    summary: Omit<CronRunStepSummary, "errors">,
    error: string | null
  ): CronRunStepSummary => ({
    ...summary,
    errors: error === null ? [] : [error],
  })
  return {
    outbox: step(
      {
        processed: result.processed,
        sent: result.sent,
        failed: result.failed,
        skipped: result.skipped,
      },
      result.outboxError
    ),
    rescore: step(
      {
        processed: result.rescored,
        sent: result.markedSpam,
        failed: 0,
        skipped: result.rescoreSkipped,
      },
      result.rescoreError
    ),
    digest: step(
      {
        processed: result.digests + result.digestSkipped,
        sent: result.digests,
        failed: 0,
        skipped: result.digestSkipped,
      },
      result.digestError
    ),
    expiry: step(
      {
        processed: result.subscriptionsExpired + result.subscriptionsCanceled,
        sent: result.subscriptionsExpired,
        failed: 0,
        skipped: 0,
      },
      result.expiryError
    ),
    reconcile: step(
      {
        processed: result.reconciled,
        sent: result.reconcileJobsCreated,
        failed: 0,
        skipped: 0,
      },
      result.reconcileError
    ),
  }
}

/** A steps object for a run that threw before producing a result:
    the failure is recorded on the outbox step (the step that owns
    the drain), the other steps stay zeroed. */
export function failedCronRunSteps(message: string): CronRunSteps {
  const steps = emptyCronRunSteps()
  steps.outbox.errors = [message]
  return steps
}

/** Run status from a finished result.
    - FAILED: every step errored — nothing ran at all. (A run that
      threw outright is also FAILED; see the catch in
      `executeEmailOutboxCron`.)
    - PARTIAL: at least one step errored, or at least one outbox job
      failed. `skipped` does NOT make a run partial: a job skipped
      because the other processor claimed it first (EML-038) still
      got done, and rescore/digest skips are routine no-ops (AI off,
      nothing due) — a healthy run with AI off would otherwise read
      PARTIAL every day.
    - SUCCESS: every step ran clean and no job failed. */
export function deriveCronRunStatus(
  result: EmailOutboxCronResult
): CronRunStatus {
  const errors = [
    result.outboxError,
    result.rescoreError,
    result.digestError,
    result.expiryError,
    result.reconcileError,
  ].filter((error): error is string => error !== null)
  if (errors.length === 5) return "FAILED"
  if (errors.length > 0 || result.failed > 0) return "PARTIAL"
  return "SUCCESS"
}

/** Insert the RUNNING row at the start of a run. Best-effort: a
    failing write (DB down, stale generated client without the
    CronRun delegate) must never fail the run itself — the steps
    still run and the structured log line still records them. Returns
    the row id, or null when no row could be written. */
async function insertCronRunRow(opts: {
  trigger: CronTrigger
  triggeredById?: string | null
  startedAt: Date
}): Promise<string | null> {
  try {
    const row = await db.cronRun.create({
      data: {
        jobName: "EMAIL_OUTBOX",
        trigger: opts.trigger,
        triggeredById: opts.triggeredById ?? null,
        status: "RUNNING",
        startedAt: opts.startedAt,
        steps: emptyCronRunSteps(),
      },
    })
    return row.id
  } catch (err) {
    logger.error("cron run record insert failed", { error: err })
    return null
  }
}

/** Finish-update for a run row. Best-effort (same reason as the
    insert); returns the finished row, or null when no row exists or
    the write failed. */
async function finishCronRunRow(opts: {
  runId: string
  status: CronRunStatus
  steps: CronRunSteps
  finishedAt: Date
  durationMs: number
}): Promise<CronRun | null> {
  try {
    return await db.cronRun.update({
      where: { id: opts.runId },
      data: {
        status: opts.status,
        steps: opts.steps,
        finishedAt: opts.finishedAt,
        durationMs: opts.durationMs,
      },
    })
  } catch (err) {
    logger.error("cron run record finish failed", { error: err })
    return null
  }
}

/** Retention (Q8, owner-approved, plan §3.6): delete CronRun rows
    older than 90 days. CronRun rows ONLY — never any other table.
    Best-effort: a failing prune must never fail the run that just
    finished (the next run retries). */
async function pruneOldCronRuns(now: Date): Promise<void> {
  const cutoff = new Date(
    now.getTime() - CRON_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000
  )
  try {
    const deleted = await db.cronRun.deleteMany({
      where: { createdAt: { lt: cutoff } },
    })
    if (deleted.count > 0) {
      logger.info("cron run retention pruned old rows", {
        deleted: deleted.count,
        retentionDays: CRON_RUN_RETENTION_DAYS,
      })
    }
  } catch (err) {
    logger.error("cron run retention prune failed", { error: err })
  }
}

/** The shared run path: the Vercel cron route and the manual trigger
    both run through here, so a manual run is the same five steps with
    a MANUAL row. Returns the step result plus the finished CronRun
    row (null when the writer was unavailable — the steps still ran). */
async function executeEmailOutboxCron(
  opts: {
    outboxLimit?: number
    rescoreLimit?: number
    digestLimit?: number
    reconcileLimit?: number
  },
  meta: { trigger: CronTrigger; triggeredById?: string | null }
): Promise<{ result: EmailOutboxCronResult; run: CronRun | null }> {
  const startedAt = new Date()
  const startedMs = Date.now()
  const runId = await insertCronRunRow({
    trigger: meta.trigger,
    triggeredById: meta.triggeredById,
    startedAt,
  })
  try {
    const result = await runCronSteps(opts, startedMs)
    lastRun = result
    // EML-064: one structured line per run — counts + ms + per-step
    // errors — so a successful run is observable and a missed/failed
    // run is visible in the logs without opening the delivery log.
    logCronRunLine(result)
    const status = deriveCronRunStatus(result)
    const finishedAt = new Date()
    const run = runId
      ? await finishCronRunRow({
          runId,
          status,
          steps: buildCronRunSteps(result),
          finishedAt,
          durationMs: result.durationMs,
        })
      : null
    // Retention runs inside the cron run itself (Q8): the row just
    // finished is minutes old, so the prune can never catch it.
    await pruneOldCronRuns(finishedAt)
    return { result, run }
  } catch (err) {
    // A failed run must still write its row: the finish update runs
    // in this catch path (finally-style), never swallowed by the
    // throw — the row reads FAILED with the throw's message on the
    // outbox step, and the throw still propagates to the caller.
    const message = err instanceof Error ? err.message : "Unknown error"
    if (runId) {
      await finishCronRunRow({
        runId,
        status: "FAILED",
        steps: failedCronRunSteps(message),
        finishedAt: new Date(),
        durationMs: Date.now() - startedMs,
      })
    }
    throw err
  }
}

/** The five steps, isolated and concurrent (SRC-115: serially, one
    hit grew toward serverless timeouts as the queues grew); each is
    isolated, so one throwing step never cancels the others (EML-063).
    Never throws for a step failure — those are reported per step in
    the result — so the route keeps 200 with partial results. */
async function runCronSteps(
  opts: {
    outboxLimit?: number
    rescoreLimit?: number
    digestLimit?: number
    reconcileLimit?: number
  },
  started: number
): Promise<EmailOutboxCronResult> {
  const [outbox, rescore, digest, expiry, reconcile] = await Promise.all([
    runStep("outbox", () =>
      processEmailOutbox({ limit: opts.outboxLimit ?? CRON_OUTBOX_LIMIT })
    ),
    runStep("rescore", () =>
      rescoreNewSubmissions({ limit: opts.rescoreLimit ?? CRON_RESCORE_LIMIT })
    ),
    runStep("digest", () =>
      sendDueDigests({ limit: opts.digestLimit ?? CRON_DIGEST_LIMIT })
    ),
    runStep("expiry", () => expireSubscriptions(new Date())),
    runStep("reconcile", () =>
      reconcileMissingNotificationJobs({
        limit: opts.reconcileLimit ?? CRON_RECONCILE_LIMIT,
      })
    ),
  ])
  const expired = expiry.value ?? []
  return {
    processed: outbox.value?.processed ?? 0,
    sent: outbox.value?.sent ?? 0,
    failed: outbox.value?.failed ?? 0,
    skipped: outbox.value?.skipped ?? 0,
    outboxError: outbox.error,
    rescored: rescore.value?.checked ?? 0,
    markedSpam: rescore.value?.markedSpam ?? 0,
    rescoreSkipped: rescore.value?.skipped ?? 0,
    rescoreError: rescore.error,
    digests: digest.value?.sent ?? 0,
    digestSkipped: digest.value?.skipped ?? 0,
    digestError: digest.error,
    subscriptionsExpired: expired.filter((r) => r.toStatus === "EXPIRED")
      .length,
    subscriptionsCanceled: expired.filter((r) => r.toStatus === "CANCELED")
      .length,
    expiryError: expiry.error,
    reconciled: reconcile.value?.reconciled ?? 0,
    reconcileJobsCreated: reconcile.value?.jobsCreated ?? 0,
    reconcileError: reconcile.error,
    durationMs: Date.now() - started,
    runAt: new Date().toISOString(),
  }
}

function logCronRunLine(result: EmailOutboxCronResult): void {
  const errors = [
    result.outboxError,
    result.rescoreError,
    result.digestError,
    result.expiryError,
    result.reconcileError,
  ].filter((error): error is string => error !== null)
  const fields = {
    processed: result.processed,
    sent: result.sent,
    failed: result.failed,
    skipped: result.skipped,
    rescored: result.rescored,
    markedSpam: result.markedSpam,
    rescoreSkipped: result.rescoreSkipped,
    digests: result.digests,
    digestSkipped: result.digestSkipped,
    subscriptionsExpired: result.subscriptionsExpired,
    subscriptionsCanceled: result.subscriptionsCanceled,
    reconciled: result.reconciled,
    reconcileJobsCreated: result.reconcileJobsCreated,
    durationMs: result.durationMs,
    ...(errors.length > 0 ? { errors } : {}),
  }
  if (errors.length > 0) {
    logger.error("cron:email-outbox run finished with step errors", fields)
  } else {
    logger.info("cron:email-outbox run complete", fields)
  }
}

/** Runs the five scheduled email jobs (the Vercel cron route's entry
    point; trigger VERCEL_CRON). The steps are independent, so they run
    concurrently; each is isolated, so one throwing step never cancels
    the others. Never throws for a step failure — those are reported
    per step in the result. Every invocation writes a CronRun row. */
export async function runEmailOutboxCron(
  opts: {
    outboxLimit?: number
    rescoreLimit?: number
    digestLimit?: number
    reconcileLimit?: number
  } = {}
): Promise<EmailOutboxCronResult> {
  const { result } = await executeEmailOutboxCron(opts, {
    trigger: "VERCEL_CRON",
  })
  return result
}

/** The standalone worker's failed-poll record (Q8, plan §3.6): the
    worker writes a CronRun row ONLY on a failed poll — never one row
    per poll (~2,880 rows/day at the 30 s cadence). Successful polls
    write nothing; their state lives in the worker's in-memory health
    (`lastRunAt`) and the EmailJob rows they touched. Best-effort and
    never throws: a failing record write must never kill the worker
    (the health endpoint already surfaces the poll error). Returns
    the row, or null when no row could be written. */
export async function recordWorkerFailedPoll(input: {
  error: string
  startedAt: Date
  durationMs: number
}): Promise<CronRun | null> {
  try {
    return await db.cronRun.create({
      data: {
        jobName: "EMAIL_OUTBOX",
        trigger: "WORKER",
        status: "FAILED",
        startedAt: input.startedAt,
        finishedAt: new Date(input.startedAt.getTime() + input.durationMs),
        durationMs: input.durationMs,
        steps: failedCronRunSteps(input.error),
      },
    })
  } catch (err) {
    logger.error("worker failed-poll record failed", { error: err })
    return null
  }
}

// ─── CronRun reads + manual trigger (Jobs page / API) ───────────────────

/** Paginated CronRun list, newest first. Reads need VIEW_JOBS (all
    staff — Health-page parity, plan §3.6 + Q9). Filters are the
    route-validated `CronRunsQuery`; page / perPage are clamped
    defensively here too. */
export async function listCronRuns(
  actor: CronAdminActor,
  filters: CronRunsQuery
): Promise<{
  runs: CronRun[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "VIEW_JOBS")
  const page = Math.max(1, Math.floor(filters.page) || 1)
  const perPage = Math.min(
    CRON_RUNS_MAX_PER_PAGE,
    Math.max(1, Math.floor(filters.perPage) || CRON_RUNS_DEFAULT_PER_PAGE)
  )
  const where: Prisma.CronRunWhereInput = {
    ...(filters.jobName ? { jobName: filters.jobName } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.trigger ? { trigger: filters.trigger } : {}),
  }
  const [total, runs] = await Promise.all([
    db.cronRun.count({ where }),
    db.cronRun.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ])
  return {
    runs,
    total,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  }
}

/** The newest CronRun row, or null when no run has ever been
    recorded. Reads need VIEW_JOBS (same as the list). This is the
    table read — `getLastCronRun` (in-memory, per serverless
    instance) is NOT a substitute for it. */
export async function getLatestCronRun(
  actor: CronAdminActor
): Promise<CronRun | null> {
  requireAdmin(actor, "VIEW_JOBS")
  return db.cronRun.findFirst({ orderBy: { createdAt: "desc" } })
}

/** Manual "Run now" (Jobs page `PageHeader` action): runs the
    email-outbox cron through the same path as the Vercel cron, with
    a MANUAL CronRun row carrying the actor's id, and writes an audit
    row for the trigger. Gated on MANAGE_JOBS (Q9: SUPER_ADMIN +
    owner — MANAGER views Jobs but never requeues or triggers a run;
    SUPPORT never mutates it) + step-up re-auth, checked last, after
    every cheap guard, immediately before the run — the requeue/refund
    pattern (Phase B): one password entry authorizes exactly one
    manual run (single-use). A manual run sends customer email, so
    it is never gated on a read capability.
    Audit resource: no CRON_RUN value exists in `AuditResource`
    (adding one needs an enum migration; Phase C's migration is
    scoped to the CronRun model per plan §4, and the COUPON enum
    value is Phase D's change). SETTINGS is the generic
    platform-operations bucket until a CRON_RUN value is added. */
export async function runManualEmailOutboxCron(
  actor: CronAdminActor,
  opts: {
    outboxLimit?: number
    rescoreLimit?: number
    digestLimit?: number
    reconcileLimit?: number
  } = {}
): Promise<CronRun> {
  requireAdmin(actor, "MANAGE_JOBS")
  // Step-up (Phase 9): checked last, after every cheap guard,
  // immediately before the run — the admin-users disable pattern.
  // Consumes one unbound admin verification, so one password entry
  // authorizes exactly one manual run.
  await requireStepUp(actor)
  const { run } = await executeEmailOutboxCron(opts, {
    trigger: "MANUAL",
    triggeredById: actor.user.id,
  })
  if (!run) {
    // The run itself completed, but its record could not be written
    // — reporting success would lie to the operator, because the
    // Jobs page would show no run at all. 503, not a silent success.
    throw new ApiError(
      "Manual cron run finished but its run record could not be written.",
      503
    )
  }
  await logAudit({
    userId: actor.user.id,
    action: "CREATE",
    resourceType: "SETTINGS",
    resourceId: run.id,
    detail: {
      event: "manual-cron-run",
      jobName: run.jobName,
      trigger: "MANUAL",
      status: run.status,
      durationMs: run.durationMs,
    },
  })
  return run
}

/** Reconciliation (DB-032 / EML-043): NEW submissions older than
    `olderThanMinutes` with no `EmailJob` at all get their notification
    jobs (re-)created via the normal enqueue path — the case the old
    fire-and-forget enqueue after the submission save could lose with
    no retry path. Exactly-once guard: a submission that already has
    jobs is skipped, so a second run (or the normal path winning the
    race) never double-enqueues. Residual race: two reconcilers
    overlapping between the count check and the enqueue could both
    create jobs — the cron runs once a day and the worker never
    reconciles, so overlapping runs are not expected. */
export async function reconcileMissingNotificationJobs(
  opts: { olderThanMinutes?: number; limit?: number } = {}
): Promise<ReconcileResult> {
  const olderThanMinutes = opts.olderThanMinutes ?? RECONCILE_MIN_AGE_MINUTES
  const limit = opts.limit ?? CRON_RECONCILE_LIMIT
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000)
  const candidates = await db.submission.findMany({
    where: { status: SubmissionStatus.NEW, createdAt: { lt: cutoff } },
    select: { id: true, formId: true },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(limit, 100)),
  })
  let reconciled = 0
  let jobsCreated = 0
  for (const candidate of candidates) {
    const existing = await db.emailJob.count({
      where: { submissionId: candidate.id },
    })
    if (existing > 0) continue
    const created = await enqueueSubmissionNotifications(
      candidate.formId,
      candidate.id
    )
    if (created > 0) {
      reconciled++
      jobsCreated += created
    }
  }
  return { checked: candidates.length, reconciled, jobsCreated }
}
