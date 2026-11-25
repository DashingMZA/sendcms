import {
  EmailJobStatus,
  EmailJobType,
  Prisma,
  SubmissionEventType,
  SubmissionStatus,
  db,
  type EmailJob,
  type Submission,
} from "@sendcms/database"
import { ApiError, getSubmissionSender } from "@sendcms/shared"
import {
  notificationDeps,
  type DigestProps,
  type SubmissionNotificationField,
  type SubmissionNotificationProps,
} from "@sendcms/email"
import { createLogger } from "@sendcms/observability"
import {
  MAX_EMAIL_ATTEMPTS,
  claimDueEmailJobs,
  claimEmailJob,
  enqueueEmailJobs,
  loadEmailJob,
  markEmailJobFailed,
  markEmailJobSent,
  type EmailJobWithRelations,
} from "@sendcms/queue"

// Email outbox (Phase 9). Submissions are saved first and notification
// jobs are queued after — email can never lose a submission, and a
// provider outage only delays the notification. Delivery is attempted
// immediately after submit (the public route's `after()` hook) and
// retried by the cron route or the standalone worker.
//
// The queue state machine (claim / retry / mark) lives in
// `@sendcms/queue`; the send path (`notificationDeps`) lives in
// `@sendcms/email`. This module imports both directly — the Phase 5
// injection is gone, and the contract types live in `@sendcms/email`
// (re-exported below so existing `@sendcms/notifications` importers
// keep working).

// Re-exported for compatibility — the contract types now live in
// `@sendcms/email` (one-way dependency: notifications → email).
export type {
  DigestItem,
  DigestProps,
  NotificationDeps,
  NotificationEmailSender,
  NotificationRenderer,
  SubmissionNotificationField,
  SubmissionNotificationProps,
} from "@sendcms/email"

export const EMAIL_JOB_PAGE_SIZE = 20

const logger = createLogger("notifications")

export function buildSubmissionNotificationSubject(
  formName: string,
  senderName: string | null
): string {
  return senderName
    ? `New submission from ${senderName} on ${formName}`
    : `New submission on ${formName}`
}

function dashboardUrl(): string {
  // The inbox link must land on the dashboard app (Phase 8 split it off
  // the marketing app). NEXT_PUBLIC_APP_URL is the marketing app's URL —
  // the fallback covers single-app deployments only.
  return (
    process.env.NEXT_PUBLIC_DASHBOARD_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3002"
  )
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(formatFieldValue).join(", ")
  return JSON.stringify(value)
}

function submissionFields(data: unknown): SubmissionNotificationField[] {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return []
  }
  return Object.entries(data as Record<string, unknown>).map(
    ([label, value]) => ({ label, value: formatFieldValue(value) })
  )
}

type SubmissionWithForm = Submission & {
  form: { id: string; name: string }
}

/** Creates one PENDING job per enabled recipient of the form. Called
    after the submission transaction commits — never inside it, and
    never allowed to fail the submission. Spam submissions get no
    notification: the inbox still shows them, the owner is not emailed
    about junk. */
export async function enqueueSubmissionNotifications(
  formId: string,
  submissionId: string
): Promise<number> {
  const submission = await db.submission.findUnique({
    where: { id: submissionId },
    include: { form: { select: { id: true, name: true, ownerId: true } } },
  })
  if (!submission || submission.formId !== formId) return 0
  if (submission.status === SubmissionStatus.SPAM) return 0

  const recipients = await db.notificationSettings.findMany({
    where: { formId, enabled: true },
    select: { email: true },
  })
  if (recipients.length === 0) return 0

  const sender = getSubmissionSender(submission.data)
  const subject = buildSubmissionNotificationSubject(
    submission.form.name,
    sender.name
  )
  return enqueueEmailJobs(
    recipients.map((recipient) => ({
      type: EmailJobType.SUBMISSION_NOTIFICATION,
      to: recipient.email,
      subject,
      formId,
      // Phase 16 (DB-034): denormalized owner, set from the
      // already-loaded form — the outbox listing filters on this
      // column instead of joining Form.
      ownerId: submission.form.ownerId,
      submissionId,
    }))
  )
}

/** Resolves a form's owner for the denormalized EmailJob.ownerId.
    Throws when the form is gone — today the same call would fail one
    line later on the formId FK, so a missing form stays loud instead
    of silently enqueueing an owner-less job. */
async function resolveFormOwnerId(formId: string): Promise<string> {
  const form = await db.form.findUnique({
    where: { id: formId },
    select: { ownerId: true },
  })
  if (!form) throw new Error(`Form ${formId} not found.`)
  return form.ownerId
}

/** Creates one PENDING DIGEST job for the form owner. The digest
    content is pre-rendered at enqueue time (the model's summary +
    the submission list) and stored on the job payload — the send path
    renders it, it never re-runs the model. */
export async function enqueueDigest({
  formId,
  to,
  subject,
  payload,
}: {
  formId: string
  to: string
  subject: string
  payload: DigestProps
}): Promise<number> {
  // Phase 16 (DB-034): denormalized owner, resolved from the form
  // before the create — the outbox listing filters on this column
  // instead of joining Form.
  const ownerId = await resolveFormOwnerId(formId)
  return enqueueEmailJobs([
    {
      type: EmailJobType.DIGEST,
      to,
      subject,
      formId,
      ownerId,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
  ])
}

/** Creates one PENDING SUBMISSION_REPLY job for the submitter. The
    reply body is the owner's own (reviewed and edited) words, stored
    on the job payload — the send path renders it, it never re-runs
    the model. */
export async function enqueueReply({
  formId,
  submissionId,
  to,
  subject,
  body,
  formName,
}: {
  formId: string
  submissionId: string
  to: string
  subject: string
  body: string
  formName: string
}): Promise<number> {
  // Phase 16 (DB-034): denormalized owner, resolved from the form
  // before the create — the outbox listing filters on this column
  // instead of joining Form.
  const ownerId = await resolveFormOwnerId(formId)
  return enqueueEmailJobs([
    {
      type: EmailJobType.SUBMISSION_REPLY,
      to,
      subject,
      formId,
      ownerId,
      submissionId,
      payload: {
        formName,
        body,
        accentColor: "#0891b2",
        footerText: `You're receiving this because you messaged us on ${formName}.`,
      } as unknown as Prisma.InputJsonValue,
    },
  ])
}

/** The payload a SUBMISSION_REPLY job carries. Written by the inbox
    service, read by the send path — a malformed one fails the job, it
    never sends a half-rendered reply. */
export function parseReplyPayload(payload: unknown): {
  formName: string
  body: string
  accentColor: string
  footerText: string
} | null {
  if (typeof payload !== "object" || payload === null) return null
  const p = payload as Record<string, unknown>
  if (typeof p.formName !== "string" || typeof p.body !== "string") {
    return null
  }
  return {
    formName: p.formName,
    body: p.body,
    accentColor: typeof p.accentColor === "string" ? p.accentColor : "#0891b2",
    footerText: typeof p.footerText === "string" ? p.footerText : "",
  }
}
export function parseDigestPayload(payload: unknown): DigestProps | null {
  if (typeof payload !== "object" || payload === null) return null
  const p = payload as Record<string, unknown>
  if (
    typeof p.formName !== "string" ||
    typeof p.count !== "number" ||
    typeof p.summary !== "string" ||
    !Array.isArray(p.highlights) ||
    !Array.isArray(p.items) ||
    typeof p.inboxUrl !== "string"
  ) {
    return null
  }
  return {
    formName: p.formName,
    count: p.count,
    summary: p.summary,
    highlights: p.highlights.filter((h): h is string => typeof h === "string"),
    items: p.items
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null
      )
      .map((item) => {
        // SRC-236: an unparseable receivedAt used to become an
        // Invalid Date and ride into the rendered digest. Such an
        // item is dropped instead — the stored payload is corrupt
        // and the time is part of the rendered row. (DigestItem
        // requires a Date, so null is not an option here.)
        const receivedAt =
          item.receivedAt instanceof Date
            ? item.receivedAt
            : new Date(String(item.receivedAt))
        if (Number.isNaN(receivedAt.getTime())) return null
        return {
          senderName:
            typeof item.senderName === "string" ? item.senderName : null,
          snippet: typeof item.snippet === "string" ? item.snippet : "",
          receivedAt,
        }
      })
      .filter((item): item is DigestProps["items"][number] => item !== null),
    inboxUrl: p.inboxUrl,
    accentColor: typeof p.accentColor === "string" ? p.accentColor : "#0891b2",
    footerText:
      typeof p.footerText === "string"
        ? p.footerText
        : "You're receiving this because you get digests for this form.",
  }
}

async function renderNotification(
  submission: SubmissionWithForm
): Promise<{ subject: string; html: string; text: string }> {
  const sender = getSubmissionSender(submission.data)
  const subject = buildSubmissionNotificationSubject(
    submission.form.name,
    sender.name
  )
  const props: SubmissionNotificationProps = {
    formName: submission.form.name,
    senderName: sender.name,
    senderEmail: sender.email,
    fields: submissionFields(submission.data),
    pageUrl: submission.pageUrl,
    originDomain: submission.originDomain,
    receivedAt: submission.createdAt,
    inboxUrl: `${dashboardUrl()}/dashboard/inbox/${submission.id}`,
    accentColor: "#0891b2",
    footerText:
      "You're receiving this because you get notifications for this form.",
  }
  const { html, text } = await notificationDeps.renderNotification(props)
  return { subject, html, text }
}

/** Timeline event for a reply job, written from the send path only
    (EML-007): EMAIL_SENT once the provider accepts the reply,
    EMAIL_FAILED once it terminally fails. Best-effort and silent —
    the job outcome is already recorded, and a timeline write must
    never flip a sent job to failed. This package owns no logger. */
async function writeReplyEvent(
  job: EmailJob,
  type: SubmissionEventType,
  detail: Prisma.InputJsonValue
): Promise<void> {
  if (!job.submissionId) return
  try {
    await db.submissionEvent.create({
      data: { submissionId: job.submissionId, type, detail },
    })
  } catch {
    // The timeline is secondary to the recorded job outcome.
  }
}

/** Sends one due job. Returns "sent" | "failed" | "skipped" (claimed
    by another processor, or its submission is gone). */
async function processOneJob(
  job: EmailJob
): Promise<"sent" | "failed" | "skipped"> {
  // Claim: only the processor that flips PENDING → SENDING owns it.
  if (!(await claimEmailJob(job.id))) return "skipped"

  const attempts = job.attempts + 1
  try {
    // DIGEST jobs carry their pre-rendered content on the payload —
    // no submission to load, and the model is never re-run at send
    // time.
    if (job.type === EmailJobType.DIGEST) {
      const props = parseDigestPayload(job.payload)
      if (!props) {
        throw new Error("Digest payload is missing or malformed.")
      }
      const { html, text } = await notificationDeps.renderDigest(props)
      const { messageId } = await notificationDeps.sendEmail({
        to: job.to,
        subject: job.subject,
        html,
        text,
      })
      await markEmailJobSent(job.id, messageId)
      return "sent"
    }
    // SUBMISSION_REPLY jobs carry the owner's reply body on the
    // payload — same rule as DIGEST: render it, never re-run the model.
    if (job.type === EmailJobType.SUBMISSION_REPLY) {
      const props = parseReplyPayload(job.payload)
      if (!props) {
        throw new Error("Reply payload is missing or malformed.")
      }
      const { html, text } = await notificationDeps.renderReply(props)
      const { messageId } = await notificationDeps.sendEmail({
        to: job.to,
        subject: job.subject,
        html,
        text,
      })
      await markEmailJobSent(job.id, messageId)
      await writeReplyEvent(job, SubmissionEventType.EMAIL_SENT, {
        reply: true,
      })
      return "sent"
    }
    const full: EmailJobWithRelations | null = await loadEmailJob(job.id)
    if (!full?.submission || !full.form) {
      throw new Error("Submission or form no longer exists.")
    }
    const { subject, html, text } = await renderNotification({
      ...full.submission,
      form: full.form,
    })
    const { messageId } = await notificationDeps.sendEmail({
      to: full.to,
      subject: full.subject || subject,
      html,
      text,
    })
    await markEmailJobSent(job.id, messageId)
    return "sent"
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    // Retriable failures stay PENDING with a backoff — the next drain
    // picks them up again. Only terminal failures (out of attempts, or
    // the submission is gone) become FAILED.
    const terminal =
      message === "Submission or form no longer exists." ||
      message === "Digest payload is missing or malformed." ||
      message === "Reply payload is missing or malformed." ||
      attempts >= MAX_EMAIL_ATTEMPTS
    // SRC-329 (Phase 16, Wave 3): the queue re-reads the attempt
    // count from the row for its own cutoff/backoff — this snapshot
    // is only used for the caller's terminal decision below.
    await markEmailJobFailed(job.id, {
      error: message,
      terminal,
    })
    // EML-007: a reply job that will never be retried gets an
    // EMAIL_FAILED timeline event; a retriable failure gets none —
    // the job is still in flight.
    if (job.type === EmailJobType.SUBMISSION_REPLY && terminal) {
      await writeReplyEvent(job, SubmissionEventType.EMAIL_FAILED, {
        reply: true,
        error: message.slice(0, 500),
      })
    }
    return "failed"
  }
}

/** Sends due PENDING jobs (never attempted, or past their retry time).
    Returns the outcome counts. Safe to call from the cron route, the
    standalone worker, and the submit route's `after()` hook. */
export async function processEmailOutbox({
  limit = 25,
}: { limit?: number } = {}): Promise<{
  processed: number
  sent: number
  failed: number
}> {
  const due = await claimDueEmailJobs(limit)
  let sent = 0
  let failed = 0
  for (const job of due) {
    const outcome = await processOneJob(job)
    if (outcome === "sent") sent++
    if (outcome === "failed") failed++
  }
  return { processed: due.length, sent, failed }
}

export type EmailJobListItem = EmailJob & {
  formName: string | null
}

export type EmailJobListResult = {
  items: EmailJobListItem[]
  total: number
  page: number
  pageSize: number
  counts: Record<"all" | "pending" | "sent" | "failed", number>
}

export async function listEmailJobsForUser(
  userId: string,
  filters: {
    status?: "PENDING" | "SENT" | "FAILED"
    formId?: string
    page?: number
  }
): Promise<EmailJobListResult> {
  const page = Math.max(1, filters.page ?? 1)
  // Phase 16 (DB-034): the denormalized ownerId filters the owner's
  // jobs directly — no Form join for the owner filter (Stream C
  // proved the join still seq-scans at 220k rows). The form include
  // below stays: it only supplies the display name.
  const baseWhere = { ownerId: userId }
  const where = {
    ...baseWhere,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.formId ? { formId: filters.formId } : {}),
  }
  const [items, total, counts] = await Promise.all([
    db.emailJob.findMany({
      where,
      include: { form: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * EMAIL_JOB_PAGE_SIZE,
      take: EMAIL_JOB_PAGE_SIZE,
    }),
    db.emailJob.count({ where }),
    db.emailJob.groupBy({
      by: ["status"],
      where: {
        ...baseWhere,
        ...(filters.formId ? { formId: filters.formId } : {}),
      },
      _count: true,
    }),
  ])
  const byStatus = new Map(counts.map((c) => [c.status, c._count]))
  const at = (status: EmailJobStatus) => byStatus.get(status) ?? 0
  return {
    items: items.map((item) => ({
      ...item,
      formName: item.form?.name ?? null,
    })),
    total,
    page,
    pageSize: EMAIL_JOB_PAGE_SIZE,
    counts: {
      all:
        at(EmailJobStatus.PENDING) +
        at(EmailJobStatus.SENT) +
        at(EmailJobStatus.FAILED) +
        at(EmailJobStatus.SENDING),
      pending: at(EmailJobStatus.PENDING),
      sent: at(EmailJobStatus.SENT),
      failed: at(EmailJobStatus.FAILED),
    },
  }
}

/** Sends a sample notification for a form straight through the
    provider (not via the outbox — there is no submission to render
    from, and the point is to test the provider right now). */
export async function sendTestSubmissionEmail(
  userId: string,
  formId: string,
  to: string
): Promise<{ messageId: string; provider: string }> {
  const form = await db.form.findFirst({
    where: { id: formId, ownerId: userId },
    select: { id: true, name: true },
  })
  if (!form) {
    throw new ApiError("Form not found.", 404)
  }
  const props: SubmissionNotificationProps = {
    formName: form.name,
    senderName: "Test Visitor",
    senderEmail: "test@example.com",
    fields: [
      { label: "name", value: "Test Visitor" },
      { label: "email", value: "test@example.com" },
      {
        label: "message",
        value:
          "This is a test notification from SendCMS. Your form's email notifications are working.",
      },
    ],
    pageUrl: null,
    originDomain: "test",
    receivedAt: new Date(),
    inboxUrl: `${dashboardUrl()}/dashboard/forms/${form.id}`,
    accentColor: "#0891b2",
    footerText: "This is a test email from SendCMS.",
  }
  const { html, text } = await notificationDeps.renderNotification(props)
  try {
    const { messageId, provider } = await notificationDeps.sendEmail({
      to,
      subject: `Test notification from ${form.name}`,
      html,
      text,
    })
    return { messageId, provider }
  } catch (err) {
    // AIM-010: the provider's message names the platform's email
    // configuration (e.g. which env vars are unset) — that detail
    // stays server-side in the log; the caller (any FULL-key holder
    // via send_test_email) gets a generic downstream failure.
    logger.error("test submission email failed", {
      error: err,
      formId,
      to,
    })
    throw new ApiError("Could not send the test email.", 502)
  }
}
