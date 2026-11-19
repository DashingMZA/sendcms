import {
  EmailJobStatus,
  EmailJobType,
  SubmissionStatus,
  db,
  type EmailJob,
  type Submission,
} from "@sendcms/database"
import { ApiError, getSubmissionSender } from "@sendcms/shared"
import {
  notificationDeps,
  type SubmissionNotificationField,
  type SubmissionNotificationProps,
} from "@sendcms/email"
import {
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
  NotificationDeps,
  NotificationEmailSender,
  NotificationRenderer,
  SubmissionNotificationField,
  SubmissionNotificationProps,
} from "@sendcms/email"

export const EMAIL_JOB_PAGE_SIZE = 20

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
    include: { form: { select: { id: true, name: true } } },
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
      submissionId,
    }))
  )
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

/** Sends one due job. Returns "sent" | "failed" | "skipped" (claimed
    by another processor, or its submission is gone). */
async function processOneJob(
  job: EmailJob
): Promise<"sent" | "failed" | "skipped"> {
  // Claim: only the processor that flips PENDING → SENDING owns it.
  if (!(await claimEmailJob(job.id))) return "skipped"

  const attempts = job.attempts + 1
  try {
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
    await markEmailJobFailed(job.id, {
      error: message,
      attempts,
      terminal: message === "Submission or form no longer exists.",
    })
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
  const baseWhere = { form: { ownerId: userId } }
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
    // A provider failure is a downstream (502) failure, and the
    // provider's message is the useful part — surface it instead of
    // the generic 500 handleApiError gives unknown errors.
    throw new ApiError(
      err instanceof Error ? err.message : "Could not send the test email.",
      502
    )
  }
}
