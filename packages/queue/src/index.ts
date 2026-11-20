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

export const MAX_EMAIL_ATTEMPTS = 5

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
  formId: string
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

/** Due PENDING jobs (never attempted, or past their retry time),
    oldest first. The limit is clamped to 1..100. */
export async function claimDueEmailJobs(limit: number): Promise<EmailJob[]> {
  return db.emailJob.findMany({
    where: {
      status: EmailJobStatus.PENDING,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(limit, 100)),
  })
}

/** Atomic claim: only the processor that flips PENDING → SENDING owns
    the job. Returns true when this caller claimed it. */
export async function claimEmailJob(id: string): Promise<boolean> {
  const claimed = await db.emailJob.updateMany({
    where: { id, status: EmailJobStatus.PENDING },
    data: {
      status: EmailJobStatus.SENDING,
      attempts: { increment: 1 },
    },
  })
  return claimed.count === 1
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
    },
  })
}

function truncateError(message: string): string {
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}

/** Failure: retriable failures stay PENDING with a backoff — the next
    drain picks them up again. Only terminal failures (out of attempts,
    or the submission/form is gone) become FAILED. */
export async function markEmailJobFailed(
  id: string,
  {
    error,
    attempts,
    terminal = false,
  }: { error: string; attempts: number; terminal?: boolean }
): Promise<void> {
  const retryable = !terminal && attempts < MAX_EMAIL_ATTEMPTS
  await db.emailJob.update({
    where: { id },
    data: {
      status: retryable ? EmailJobStatus.PENDING : EmailJobStatus.FAILED,
      lastError: truncateError(error),
      nextAttemptAt: retryable
        ? new Date(Date.now() + nextAttemptDelayMs(attempts))
        : null,
    },
  })
}
