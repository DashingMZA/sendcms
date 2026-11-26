// Scheduled email jobs (Phase 16, Wave 9). The daily cron route's
// orchestration: outbox drain + AI re-score + AI digests + subscription
// expiry (SRC-201) + missed-notification reconciliation (DB-032 /
// EML-043). One function the thin cron route calls; every step is
// isolated, so a throwing step never cancels the others (EML-063).
// Framework-independent (no Next.js imports); only services import
// @sendcms/database.
import { db, SubmissionStatus } from "@sendcms/database"
import {
  enqueueSubmissionNotifications,
  processEmailOutbox,
} from "@sendcms/notifications"
import { createLogger } from "@sendcms/observability"
import { expireSubscriptions } from "@sendcms/plans"
import { rescoreNewSubmissions, sendDueDigests } from "@sendcms/submissions"

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

/** Runs the five scheduled email jobs. The steps are independent, so
    they run concurrently (SRC-115: serially, one hit grew toward
    serverless timeouts as the queues grew); each is isolated, so one
    throwing step never cancels the others (EML-063). Never throws for
    a step failure — those are reported per step in the result — so the
    route keeps 200 with partial results. */
export async function runEmailOutboxCron(
  opts: {
    outboxLimit?: number
    rescoreLimit?: number
    digestLimit?: number
    reconcileLimit?: number
  } = {}
): Promise<EmailOutboxCronResult> {
  const started = Date.now()
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
  const result: EmailOutboxCronResult = {
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
  lastRun = result
  // EML-064: one structured line per run — counts + ms + per-step
  // errors — so a successful run is observable and a missed/failed
  // run is visible in the logs without opening the delivery log.
  const errors = [
    outbox.error,
    rescore.error,
    digest.error,
    expiry.error,
    reconcile.error,
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
  return result
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
