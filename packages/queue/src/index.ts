// Email outbox queue (Phase 9). The durable queue behind submission
// notifications: the EmailJob table. This package owns the claim and
// retry state machine — claim due jobs, mark them sent or failed with
// the backoff schedule — so the processor (packages/modules/notifications)
// only orchestrates: claim → render → send → mark. The claim is an
// atomic PENDING → SENDING flip, so two processors (the cron route and
// the standalone worker) can drain the same outbox without double-send.
// Scoped to the email outbox on purpose: there is only one queue, so a
// generic Queue<T> interface would be a fake abstraction. A second queue
// type is the point where this gets generalized.
import {
  EmailJobStatus,
  EmailJobType,
  Prisma,
  db,
  type EmailJob,
  type Submission,
} from "@sendcms/database"

/** Total attempts before a job goes terminal FAILED (Phase 16,
    Wave 9, EML-033 — owner decision 2026-11-25, option (b)): five
    retries after the first attempt, i.e. the job goes terminal only
    after attempt 6. The fifth attempt's failure schedules the 4 h
    rung of the ladder, so every rung in `nextAttemptDelayMs` is
    reachable. Was 5 (attempt 5 always terminal, the 4 h rung dead). */
export const MAX_EMAIL_ATTEMPTS = 6

/** Stale-claim lease (Phase 16, EML-031/EML-094): a job still
    SENDING this many minutes after its claim is treated as stuck —
    its processor died mid-send (SIGKILL, crash, deploy kill). The
    owner may requeue it from the delivery log. The automatic reaper
    that reclaims such jobs is Wave 9's (EML-031); this constant is
    the shared threshold so the manual requeue and the reaper agree. */
export const STALE_CLAIM_LEASE_MINUTES = 10

/** The instant before which a claim counts as stale. Exported for
    the reaper's tests — production code uses the same cutoff in
    `claimDueEmailJobs` / `claimEmailJob` so the two can never drift. */
export function staleClaimCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - STALE_CLAIM_LEASE_MINUTES * 60_000)
}

/** Backoff between attempts: 1m, 5m, 15m, 1h, 4h. Pure — tested. */
export function nextAttemptDelayMs(attempts: number): number {
  const delays = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000]
  return delays[Math.min(Math.max(attempts, 1), delays.length) - 1]
}

export type EmailJobWithRelations = EmailJob & {
  form: { id: string; name: string } | null
  submission: Submission | null
}

export type NewEmailJob = {
  type: EmailJobType
  to: string
  subject: string
  // Null for jobs that belong to no form — auth mail (verification /
  // password reset, EML-009) and test mail carry no formId.
  formId: string | null
  // Denormalized owner (Phase 16, DB-034): the form's owner, set by
  // the caller from form.ownerId — the outbox listing filters on this
  // column instead of joining Form. Required, never optional: the
  // column is NOT NULL, so a job without it fails fast at the
  // database instead of silently writing an owner-less row.
  ownerId: string
  // Only submission-notification jobs point at a submission; DIGEST
  // jobs (and auth jobs) have none.
  submissionId?: string
  // Only DIGEST jobs carry a payload (the pre-rendered digest content).
  payload?: Prisma.InputJsonValue
}

/** Creates the jobs. Returns how many were created. */
export async function enqueueEmailJobs(jobs: NewEmailJob[]): Promise<number> {
  if (jobs.length === 0) return 0
  const result = await db.emailJob.createMany({ data: jobs })
  return result.count
}

/** Due jobs, oldest first. The limit is clamped to 1..100.
    Two arms (Phase 16, Wave 9, EML-031/EML-006/SRC-302):
    - due PENDING jobs (never attempted, or past their retry time);
    - SENDING jobs whose claim lease expired — their processor died
      mid-send (SIGKILL, crash, deploy kill) and the job must be
      retried, not stranded. `claimedAt` NULL covers rows claimed
      before the column existed: they are treated as stale. */
export async function claimDueEmailJobs(limit: number): Promise<EmailJob[]> {
  const now = new Date()
  return db.emailJob.findMany({
    where: {
      OR: [
        {
          status: EmailJobStatus.PENDING,
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        {
          status: EmailJobStatus.SENDING,
          OR: [
            { claimedAt: null },
            { claimedAt: { lte: staleClaimCutoff(now) } },
          ],
        },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(limit, 100)),
  })
}

/** Atomic claim: only the processor that flips PENDING → SENDING owns
    the job. Returns true when this caller claimed it.
    Phase 16, Wave 9 (EML-032/EML-060): the claim re-validates
    due-ness in the same atomic `updateMany` — a stale selection
    cannot re-claim a job another processor already failed and
    rescheduled (`nextAttemptAt` in the future). The same guard
    covers the lease arm: a SENDING row is only re-claimable once
    its lease expired. The claim stamps `claimedAt` (the lease
    start) and increments `attempts`, so each claim counts as one
    attempt — a poison job still reaches terminal after the ladder,
    even when it is re-claimed after a crash. */
export async function claimEmailJob(id: string): Promise<boolean> {
  const now = new Date()
  const claimed = await db.emailJob.updateMany({
    where: {
      id,
      OR: [
        {
          status: EmailJobStatus.PENDING,
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        {
          status: EmailJobStatus.SENDING,
          OR: [
            { claimedAt: null },
            { claimedAt: { lte: staleClaimCutoff(now) } },
          ],
        },
      ],
    },
    data: {
      status: EmailJobStatus.SENDING,
      attempts: { increment: 1 },
      claimedAt: now,
    },
  })
  return claimed.count === 1
}

/** The post-claim attempt count, read from the row (Phase 16, Wave
    9, EML-032): the retry delay and the terminal cutoff must be
    computed from the value the claim actually wrote, never from the
    caller's pre-claim snapshot — a concurrent claim (or a
    re-claim of a stale SENDING row) would make the snapshot stale.
    Returns null when the row is gone. */
export async function readEmailJobAttempts(id: string): Promise<number | null> {
  const row = await db.emailJob.findUnique({
    where: { id },
    select: { attempts: true },
  })
  return row?.attempts ?? null
}

/** The job with the form + submission the renderer needs. */
export async function loadEmailJob(
  id: string
): Promise<EmailJobWithRelations | null> {
  return db.emailJob.findUnique({
    where: { id },
    include: { form: { select: { id: true, name: true } }, submission: true },
  })
}

/** Terminal success: SENT with the provider's message id. */
export async function markEmailJobSent(
  id: string,
  messageId: string
): Promise<void> {
  await db.emailJob.update({
    where: { id },
    data: {
      status: EmailJobStatus.SENT,
      providerMessageId: messageId,
      lastError: null,
      nextAttemptAt: null,
      // The claim is resolved — clear the lease so a later read
      // never mistakes this row for a stuck claim.
      claimedAt: null,
    },
  })
}

function truncateError(message: string): string {
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}

/** Failure: retriable failures stay PENDING with a backoff — the next
    drain picks them up again. Only terminal failures (out of attempts,
    or the submission/form is gone) become FAILED.
    SRC-329 (Phase 16, Wave 3): the attempt count is read from the row,
    never trusted from the caller — the caller only holds the snapshot
    it claimed, and a concurrent claim (or any external increment)
    would make a caller-supplied count stale, miscomputing both the
    backoff delay and the MAX_EMAIL_ATTEMPTS cutoff. A row that no
    longer exists has nothing to mark, so it returns quietly. */
export async function markEmailJobFailed(
  id: string,
  { error, terminal = false }: { error: string; terminal?: boolean }
): Promise<void> {
  const row = await db.emailJob.findUnique({
    where: { id },
    select: { attempts: true },
  })
  if (!row) return
  const attempts = row.attempts
  // EML-033 (owner decision (b)): attempt 5 stays retryable with
  // the 4 h delay; only attempt 6 goes terminal FAILED.
  const retryable = !terminal && attempts < MAX_EMAIL_ATTEMPTS
  await db.emailJob.update({
    where: { id },
    data: {
      status: retryable ? EmailJobStatus.PENDING : EmailJobStatus.FAILED,
      lastError: truncateError(error),
      nextAttemptAt: retryable
        ? new Date(Date.now() + nextAttemptDelayMs(attempts))
        : null,
      // The claim is resolved either way — clear the lease.
      claimedAt: null,
    },
  })
}

// ─── Suppression (Phase 16, Wave 9, EML-005 / EML-011) ───────────────
// A suppressed address receives no further mail. Suppression is
// scoped: a row with formId null is global (every form + digests);
// a row with a formId suppresses only that form's mail. The check
// matches either scope, so a global unsubscribe also stops form mail
// and a form unsubscribe never leaks into other forms' mail.

export type SuppressionReasonValue = "BOUNCED" | "COMPLAINED" | "UNSUBSCRIBED"

/** True when the address is suppressed globally or for this form. */
export async function isEmailSuppressed(
  email: string,
  formId?: string | null
): Promise<boolean> {
  const row = await db.emailSuppression.findFirst({
    where: {
      email,
      OR: [{ formId: null }, ...(formId ? [{ formId }] : [])],
    },
    select: { id: true },
  })
  return row !== null
}

/** Records a suppression. Idempotent: an existing row for the same
    (email, formId) scope is left alone (the first reason wins —
    a bounce that later unsubscribes stays a bounce). Postgres
    treats NULLs as distinct in the @@unique([email, formId]), so
    the upsert is a findFirst + create, never a bare unique-key
    upsert. */
export async function recordEmailSuppression({
  email,
  formId = null,
  reason,
  source,
}: {
  email: string
  formId?: string | null
  reason: SuppressionReasonValue
  source?: string
}): Promise<void> {
  const existing = await db.emailSuppression.findFirst({
    where: { email, formId },
    select: { id: true },
  })
  if (existing) return
  await db.emailSuppression.create({
    data: { email, formId, reason, source: source ?? null },
  })
}
