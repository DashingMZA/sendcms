import {
  AuditAction,
  AuditResource,
  EmailDeliveryStatus,
  EmailJobStatus,
  EmailJobType,
  Prisma,
  SubmissionEventType,
  SubmissionStatus,
  db,
  type EmailJob,
  type Submission,
} from "@sendcms/database"
import {
  ApiError,
  awaitWithTimeout,
  getSubmissionSender,
} from "@sendcms/shared"
import { getDigestIntervalHours, getNextDigestAt } from "@sendcms/ai"
import { logAudit, requireStepUp } from "@sendcms/security"
import { requireAdmin, type AdminActor } from "@sendcms/permissions"
import {
  buildUnsubscribeUrl,
  getEmailTranslator,
  notificationDeps,
  parseResendWebhookEvent,
  renderAccountApprovedEmail,
  resendEventToDeliveryStatus,
  verifyResendWebhookSignature,
  type DigestProps,
  type FailedAuthEmailRecord,
  type ResendWebhookEvent,
  type SubmissionNotificationField,
  type SubmissionNotificationProps,
} from "@sendcms/email"
import { getUserLocale } from "@sendcms/users"
import { createLogger } from "@sendcms/observability"
import {
  MAX_EMAIL_ATTEMPTS,
  STALE_CLAIM_LEASE_MINUTES,
  claimDueEmailJobs,
  claimEmailJob,
  enqueueEmailJobs,
  isEmailSuppressed,
  loadEmailJob,
  markEmailJobFailed,
  markEmailJobSent,
  readEmailJobAttempts,
  recordEmailSuppression,
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

/** Per-job send timeout (Phase 16, Wave 9, EML-037): one hung render
    or send must not stall the drain forever. `processEmailOutbox`
    races each job against this budget; on expiry the job is marked
    failed (retriable — the claim already counted the attempt, so the
    backoff rung is correct) and the drain moves on. The poll-level
    watchdog (worker `pollTimeoutMs`) is the second line of defence.
    If the hung send later completes, its `markEmailJobSent` still
    lands and corrects the state to SENT. */
export const EMAIL_JOB_TIMEOUT_MS = 30_000

/** A failure that must never be retried (Phase 16, Wave 9, EML-039):
    the submission/form is gone, or a stored payload is malformed.
    Terminal classification matches on this TYPE, never on the error
    message wording — renaming the message must not turn a terminal
    failure into futile retries (or vice versa). The message stays
    human-readable and is still recorded in `lastError`. */
export class TerminalJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TerminalJobError"
  }
}

const logger = createLogger("notifications")

/** The form owner's stored locale for email rendering — null
    (→ English) when the owner is gone or has no preference. Never
    throws: a missing locale must not fail a send. */
async function ownerLocale(ownerId: string): Promise<string | null> {
  try {
    return await getUserLocale(ownerId)
  } catch {
    return null
  }
}

export function buildSubmissionNotificationSubject(
  formName: string,
  senderName: string | null,
  locale = "en"
): string {
  const t = getEmailTranslator(locale)
  return senderName
    ? t("notificationSubjectFrom", { sender: senderName, formName })
    : t("notificationSubjectOn", { formName })
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

/** EML-011: the signed per-recipient unsubscribe URL for one mail
    (+ its form scope), or null when no signing secret is configured
    — callers then omit the link instead of emitting an
    unverifiable one. */
function unsubscribeUrlFor(to: string, formId: string | null): string | null {
  return buildUnsubscribeUrl(to, formId)
}

/** EML-011: the List-Unsubscribe header for one mail, or undefined
    when no signed URL can be built. */
function unsubscribeHeaders(
  to: string,
  formId: string | null
): Record<string, string> | undefined {
  const url = unsubscribeUrlFor(to, formId)
  return url ? { "List-Unsubscribe": `<${url}>` } : undefined
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

  // EML-005 / EML-011: a suppressed address (hard bounce, complaint,
  // unsubscribe) gets no further job for this form.
  const liveRecipients: { email: string }[] = []
  for (const recipient of recipients) {
    if (!(await isEmailSuppressed(recipient.email, formId))) {
      liveRecipients.push(recipient)
    }
  }
  if (liveRecipients.length === 0) return 0

  const sender = getSubmissionSender(submission.data)
  // The subject is stored on the job at enqueue time, so it is
  // rendered in the owner's locale here — the send path re-renders
  // the body in the same locale (renderNotification resolves it again
  // from the denormalized ownerId).
  const subject = buildSubmissionNotificationSubject(
    submission.form.name,
    sender.name,
    (await ownerLocale(submission.form.ownerId)) ?? "en"
  )
  return enqueueEmailJobs(
    liveRecipients.map((recipient) => ({
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
  // EML-011: a digest recipient who unsubscribed (or hard-bounced)
  // gets no further digest for this form.
  if (await isEmailSuppressed(to, formId)) return 0
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
  // instead of joining Form. The reply chrome follows the owner's
  // locale; the body itself is the owner's own words, never translated.
  const ownerId = await resolveFormOwnerId(formId)
  // EML-005 / EML-011: never enqueue a reply to a suppressed address.
  if (await isEmailSuppressed(to, formId)) return 0
  const locale = (await ownerLocale(ownerId)) ?? "en"
  const t = getEmailTranslator(locale)
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
        footerText: t("replyFooter", { formName }),
        locale,
      } as unknown as Prisma.InputJsonValue,
    },
  ])
}

/** Creates one PENDING auth job (verification / password reset) for
    a user — the durable, retryable record EML-009 requires. The
    rendered HTML + the link ride on the payload, so the send path
    needs no user row and never re-renders (the link's token is
    already minted). The job is due immediately (`nextAttemptAt`
    null), so the next drain retries it. The ownerId is the user the
    mail is for — EmailJob.ownerId is a User FK, and the auth user
    IS a User. */
export async function enqueueAuthEmailJob(
  record: FailedAuthEmailRecord & { userId: string }
): Promise<number> {
  const type =
    record.kind === "verification"
      ? EmailJobType.EMAIL_VERIFICATION
      : EmailJobType.PASSWORD_RESET
  return enqueueEmailJobs([
    {
      type,
      to: record.to,
      subject: record.subject,
      // Auth mail belongs to no form — null, never an empty string
      // (the delivery-log audit treats a set formId as a form link).
      formId: null,
      ownerId: record.userId,
      payload: {
        html: record.html,
        url: record.url,
      } as unknown as Prisma.InputJsonValue,
    },
  ])
}

/** DOC-003: creates one PENDING ACCOUNT_APPROVED job for a user
    whose registration was just approved. The HTML is rendered at
    enqueue time, in the recipient's stored locale (resolved from the
    user row when the caller does not pass one), and stored on the
    payload — so the send path needs no user row and never re-renders,
    the same shape as `enqueueAuthEmailJob`. The job is due
    immediately (`nextAttemptAt` null), so the next drain retries it.
    The ownerId is the user the mail is for. */
export async function enqueueAccountApprovedEmail({
  userId,
  to,
  name,
  locale,
}: {
  userId: string
  to: string
  name: string
  locale?: string
}): Promise<number> {
  const resolvedLocale = locale ?? (await ownerLocale(userId)) ?? "en"
  const url = `${dashboardUrl()}/sign-in`
  const { html, subject } = await renderAccountApprovedEmail({
    user: { name, email: to },
    url,
    locale: resolvedLocale,
  })
  return enqueueEmailJobs([
    {
      type: EmailJobType.ACCOUNT_APPROVED,
      to,
      subject,
      // Account mail belongs to no form — null, never an empty string
      // (the delivery-log audit treats a set formId as a form link).
      formId: null,
      ownerId: userId,
      payload: {
        html,
        url,
      } as unknown as Prisma.InputJsonValue,
    },
  ])
}

/** The payload an auth job (EMAIL_VERIFICATION / PASSWORD_RESET)
    carries. Written by enqueueAuthEmailJob, read by the send path —
    a malformed one fails the job terminally, it never sends a
    half-rendered auth mail. */
export function parseAuthEmailPayload(payload: unknown): {
  html: string
  url: string
} | null {
  if (typeof payload !== "object" || payload === null) return null
  const p = payload as Record<string, unknown>
  if (typeof p.html !== "string" || typeof p.url !== "string") return null
  return { html: p.html, url: p.url }
}

/** Records one verified Resend delivery event (EML-005). The job is
    found by the provider message id the webhook carries
    (`data.email_id` — the same value the send API returned and the
    outbox stored). A hard bounce or a complaint also suppresses the
    recipient, so no further job is ever enqueued to that address; a
    soft (transient) bounce never reaches this function — the parser
    maps it to no delivery status. Returns whether a job matched.
    Unknown event types are acknowledged, never failed: Resend may
    add types later, and a webhook retry storm helps nobody. */
export async function handleResendDeliveryEvent(
  event: ResendWebhookEvent
): Promise<{ matched: boolean; suppressed: boolean }> {
  const status = resendEventToDeliveryStatus(event)
  const recipient = event.data.to[0] ?? ""
  if (status === null) return { matched: false, suppressed: false }
  const job = await db.emailJob.findFirst({
    where: { providerMessageId: event.data.email_id },
    select: { id: true, formId: true },
  })
  if (job) {
    await db.emailJob.update({
      where: { id: job.id },
      data: {
        deliveryStatus: status as EmailDeliveryStatus,
        deliveryUpdatedAt: new Date(),
      },
    })
  }
  let suppressed = false
  if (status === "BOUNCED" || status === "COMPLAINED") {
    if (recipient) {
      await recordEmailSuppression({
        email: recipient,
        formId: job?.formId ?? null,
        reason: status,
        source: event.data.email_id,
      })
      suppressed = true
    }
  }
  return { matched: job !== null, suppressed }
}

/** Verifies a raw Resend webhook request and handles it
    (EML-005) — the route's whole job in one call. Returns the
    outcome the route turns into its HTTP response. */
export async function handleResendWebhookRequest({
  payload,
  svixId,
  svixTimestamp,
  svixSignature,
  secret,
}: {
  payload: string
  svixId: string | null
  svixTimestamp: string | null
  svixSignature: string | null
  secret: string | undefined
}): Promise<
  | { ok: true; matched: boolean; suppressed: boolean }
  | { ok: false; status: number; error: string }
> {
  if (!secret) {
    return {
      ok: false,
      status: 503,
      error: "Resend webhook is not configured (RESEND_WEBHOOK_SECRET).",
    }
  }
  if (
    !verifyResendWebhookSignature({
      payload,
      svixId,
      svixTimestamp,
      svixSignature,
      secret,
    })
  ) {
    return { ok: false, status: 401, error: "Invalid webhook signature." }
  }
  const event = parseResendWebhookEvent(payload)
  if (!event) {
    return { ok: false, status: 400, error: "Invalid webhook payload." }
  }
  const result = await handleResendDeliveryEvent(event)
  return { ok: true, ...result }
}

/** Honours one signed unsubscribe (EML-011): records the
    suppression (global when formId is null, that form only
    otherwise) and disables the recipient's notification-settings
    rows in scope, so the next submission never enqueues a job for
    them. Returns how many settings rows were disabled. */
export async function unsubscribeRecipient({
  email,
  formId,
}: {
  email: string
  formId: string | null
}): Promise<{ disabledSettings: number }> {
  await recordEmailSuppression({
    email,
    formId,
    reason: "UNSUBSCRIBED",
    source: "unsubscribe-link",
  })
  const disabled = await db.notificationSettings.updateMany({
    where: {
      email,
      enabled: true,
      ...(formId ? { formId } : {}),
    },
    data: { enabled: false },
  })
  logger.info("recipient unsubscribed", { email, formId })
  return { disabledSettings: disabled.count }
}

/** The payload a SUBMISSION_REPLY job carries. Written by the inbox
    service, read by the send path — a malformed one fails the job, it
    never sends a half-rendered reply. `locale` is the owner's locale
    at enqueue time; jobs enqueued before Wave 7 carry none and render
    English. */
export function parseReplyPayload(payload: unknown): {
  formName: string
  body: string
  accentColor: string
  footerText: string
  locale: string
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
    locale: typeof p.locale === "string" ? p.locale : "en",
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
    // Jobs enqueued before Wave 7 carry no locale and render English.
    locale: typeof p.locale === "string" ? p.locale : "en",
  }
}

async function renderNotification(
  submission: SubmissionWithForm,
  locale = "en",
  to?: string,
  formId?: string | null
): Promise<{ subject: string; html: string; text: string }> {
  const sender = getSubmissionSender(submission.data)
  const t = getEmailTranslator(locale)
  const subject = buildSubmissionNotificationSubject(
    submission.form.name,
    sender.name,
    locale
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
    footerText: t("notificationFooter"),
    locale,
    // EML-011: the signed per-recipient unsubscribe URL, rendered in
    // the layout footer + carried as a List-Unsubscribe header.
    unsubscribeUrl:
      to !== undefined ? unsubscribeUrlFor(to, formId ?? null) : null,
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

  // EML-032: the retry delay and the terminal cutoff are computed
  // from the POST-CLAIM attempt count, read back from the row —
  // never from the pre-claim snapshot. A stale snapshot (or a
  // re-claim of a stale SENDING row, whose attempts already include
  // the dead claim) would schedule a shorter delay than the job
  // earned. Falls back to snapshot + 1 only if the row vanished
  // between the claim and the read (the marks below then no-op).
  const attempts = (await readEmailJobAttempts(job.id)) ?? job.attempts + 1
  try {
    // ── Wave 9, Stream C — minimal hooks in Stream A's file ──
    // EML-005 / EML-011: a recipient suppressed after enqueue (hard
    // bounce, complaint, unsubscribe) never gets a send — the job
    // fails terminally instead of burning retries on a dead address.
    if (
      job.type === EmailJobType.SUBMISSION_NOTIFICATION ||
      job.type === EmailJobType.DIGEST ||
      job.type === EmailJobType.SUBMISSION_REPLY
    ) {
      if (await isEmailSuppressed(job.to, job.formId)) {
        throw new TerminalJobError(
          "Recipient is suppressed (bounced, complained, or unsubscribed)."
        )
      }
    }
    // EML-009: auth jobs carry their rendered HTML on the payload —
    // send it directly, no submission to load, no re-render (the
    // link's token is already minted).
    if (
      job.type === EmailJobType.EMAIL_VERIFICATION ||
      job.type === EmailJobType.PASSWORD_RESET
    ) {
      const auth = parseAuthEmailPayload(job.payload)
      if (!auth) {
        throw new TerminalJobError(
          "Auth email payload is missing or malformed."
        )
      }
      const { messageId } = await notificationDeps.sendEmail({
        to: job.to,
        subject: job.subject,
        html: auth.html,
      })
      await markEmailJobSent(job.id, messageId)
      return "sent"
    }
    // DOC-003: account-approved jobs carry their rendered HTML on
    // the payload, like auth jobs — send it directly, no re-render.
    // No suppression check (account-critical mail, like auth jobs).
    if (job.type === EmailJobType.ACCOUNT_APPROVED) {
      const approved = parseAuthEmailPayload(job.payload)
      if (!approved) {
        throw new TerminalJobError(
          "Account-approved email payload is missing or malformed."
        )
      }
      const { messageId } = await notificationDeps.sendEmail({
        to: job.to,
        subject: job.subject,
        html: approved.html,
      })
      await markEmailJobSent(job.id, messageId)
      return "sent"
    }
    // ── end Stream C hooks ──
    // DIGEST jobs carry their pre-rendered content on the payload —
    // no submission to load, and the model is never re-run at send
    // time.
    if (job.type === EmailJobType.DIGEST) {
      const props = parseDigestPayload(job.payload)
      if (!props) {
        throw new TerminalJobError("Digest payload is missing or malformed.")
      }
      // EML-011: the signed unsubscribe URL + List-Unsubscribe header.
      props.unsubscribeUrl = unsubscribeUrlFor(job.to, job.formId)
      const { html, text } = await notificationDeps.renderDigest(props)
      const { messageId } = await notificationDeps.sendEmail({
        to: job.to,
        subject: job.subject,
        html,
        text,
        headers: unsubscribeHeaders(job.to, job.formId),
      })
      await markEmailJobSent(job.id, messageId)
      return "sent"
    }
    // SUBMISSION_REPLY jobs carry the owner's reply body on the
    // payload — same rule as DIGEST: render it, never re-run the model.
    if (job.type === EmailJobType.SUBMISSION_REPLY) {
      const props = parseReplyPayload(job.payload)
      if (!props) {
        throw new TerminalJobError("Reply payload is missing or malformed.")
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
      throw new TerminalJobError("Submission or form no longer exists.")
    }
    // The body renders in the owner's locale at send time (resolved
    // from the denormalized ownerId), matching the subject stored at
    // enqueue time.
    const { subject, html, text } = await renderNotification(
      {
        ...full.submission,
        form: full.form,
      },
      (job.ownerId ? await ownerLocale(job.ownerId) : null) ?? "en",
      full.to,
      full.formId
    )
    const { messageId } = await notificationDeps.sendEmail({
      to: full.to,
      subject: full.subject || subject,
      html,
      text,
      headers: unsubscribeHeaders(full.to, full.formId),
    })
    await markEmailJobSent(job.id, messageId)
    return "sent"
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    // Retriable failures stay PENDING with a backoff — the next drain
    // picks them up again. Only terminal failures (out of attempts,
    // or a TerminalJobError) become FAILED. EML-039: the terminal
    // classification is the error TYPE, not the message wording.
    const terminal =
      err instanceof TerminalJobError || attempts >= MAX_EMAIL_ATTEMPTS
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

/** Sends due PENDING jobs (never attempted, or past their retry time)
    — plus SENDING jobs whose claim lease expired (EML-031). Returns
    the outcome counts. Safe to call from the cron route, the
    standalone worker, and the submit route's `after()` hook.
    EML-038: `processed` counts jobs this caller actually attempted
    (`sent + failed`); jobs skipped because another processor claimed
    them are reported separately as `skipped`, so the counts always
    reconcile: `processed == sent + failed` and
    `selected == processed + skipped`. */
export async function processEmailOutbox({
  limit = 25,
  jobTimeoutMs = EMAIL_JOB_TIMEOUT_MS,
}: { limit?: number; jobTimeoutMs?: number } = {}): Promise<{
  processed: number
  sent: number
  failed: number
  skipped: number
}> {
  const due = await claimDueEmailJobs(limit)
  let sent = 0
  let failed = 0
  let skipped = 0
  // DB-047: drain with a small concurrency cap instead of one send
  // at a time — a 100-job backlog used to drain one SMTP round trip
  // at a time. The claim already prevents double-send, so parallel
  // attempts cannot deliver the same job twice; the per-job timeout
  // below still bounds each attempt.
  let next = 0
  async function drainWorker(): Promise<void> {
    while (next < due.length) {
      const job = due[next++]
      const outcome = await attemptOneJob(job, jobTimeoutMs)
      if (outcome === "sent") sent++
      if (outcome === "failed") failed++
      if (outcome === "skipped") skipped++
    }
  }
  const workers = Math.min(EMAIL_OUTBOX_DRAIN_CONCURRENCY, due.length)
  await Promise.all(Array.from({ length: workers }, () => drainWorker()))
  return { processed: sent + failed, sent, failed, skipped }
}

/** DB-047: at most this many sends in flight during one drain. 5
    keeps a slow provider from serialising the queue while bounding
    the SMTP burst a single poll can make. */
export const EMAIL_OUTBOX_DRAIN_CONCURRENCY = 5

/** One job's attempt (extracted from processEmailOutbox so the drain
    can run several in parallel): race the send against the per-job
    timeout, count the outcome. `processOneJob` catches its own
    errors, so the attempt promise never rejects after the timeout
    wins except for a claim throw; the no-op catch below keeps that
    from surfacing as an unhandled rejection. */
async function attemptOneJob(
  job: EmailJob,
  jobTimeoutMs: number
): Promise<"sent" | "failed" | "skipped"> {
  // EML-037: race each job against the per-job timeout. A hung
  // render/send must fail that job (retriable) and let the drain
  // move on — never stall the whole poll.
  const attempt = processOneJob(job)
  attempt.catch(() => {})
  const outcome = await awaitWithTimeout(attempt, jobTimeoutMs)
  if (outcome === undefined) {
    // Timed out: the claim already counted this attempt, so
    // marking it failed schedules the correct backoff rung and
    // clears the lease. If the hung send later completes, its
    // markEmailJobSent still lands and corrects the state.
    await markEmailJobFailed(job.id, {
      error: `Email job timed out after ${jobTimeoutMs} ms`,
      terminal: false,
    })
    return "failed"
  }
  return outcome
}

export type EmailJobListItem = EmailJob & {
  formName: string | null
  /** Minutes since the job was claimed (SENDING only, from
      `updatedAt` — the claim is the last write a SENDING row gets).
      Null for every other status. EML-094. */
  claimAgeMinutes: number | null
  /** Whether the delivery log may offer a requeue for this row:
      FAILED always, SENDING only once it is stuck past the lease
      (EML-094/095). Computed server-side — the client never imports
      the queue's lease constant. */
  canRequeue: boolean
}

export type EmailJobListResult = {
  items: EmailJobListItem[]
  total: number
  page: number
  pageSize: number
  counts: Record<"all" | "pending" | "sending" | "sent" | "failed", number>
}

/** Minutes since `date`, rounded down, never negative. */
function ageMinutesSince(date: Date): number {
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000))
}

/** Shared list-row shape for an EmailJob (EML-094/095): claim age
    for SENDING rows, and whether the delivery log / Jobs page may
    offer a requeue for the row. Both the owner list and the admin
    list map through this so the two views can never disagree about
    a row's requeueability. */
function toEmailJobListItem(
  item: EmailJob & { form: { name: string } | null }
): EmailJobListItem {
  // EML-094: a SENDING row carries its claim age so a stuck job
  // is visible, not just present. EML-031: the age is measured
  // from the claim lease start (`claimedAt`), falling back to
  // `updatedAt` for rows claimed before the column existed.
  const claimAgeMinutes =
    item.status === EmailJobStatus.SENDING
      ? ageMinutesSince(item.claimedAt ?? item.updatedAt)
      : null
  return {
    ...item,
    formName: item.form?.name ?? null,
    claimAgeMinutes,
    canRequeue:
      item.status === EmailJobStatus.FAILED ||
      (item.status === EmailJobStatus.SENDING &&
        (claimAgeMinutes ?? 0) >= STALE_CLAIM_LEASE_MINUTES),
  }
}

/** Shared requeue guard for `requeueEmailJob` and
    `requeueEmailJobForAdmin` (one implementation, so admin vs owner
    parity is structural, not two copies that can drift). FAILED is
    terminal — requeue restarts the ladder. A SENDING job inside the
    10-min claim lease is refused (409) — its processor may still be
    alive, and requeueing it could double-send. Anything else
    (PENDING / SENT) is refused (409). */
function assertJobRequeueable(job: EmailJob): void {
  if (job.status === EmailJobStatus.FAILED) {
    return
  }
  if (job.status === EmailJobStatus.SENDING) {
    // EML-031: the lease is measured from the claim start.
    const claimAgeMinutes = ageMinutesSince(job.claimedAt ?? job.updatedAt)
    if (claimAgeMinutes < STALE_CLAIM_LEASE_MINUTES) {
      throw new ApiError(
        `This email is still being sent (claimed ${claimAgeMinutes} minute${claimAgeMinutes === 1 ? "" : "s"} ago). Wait until it is stuck past the ${STALE_CLAIM_LEASE_MINUTES}-minute lease, then retry.`,
        409
      )
    }
    return
  }
  throw new ApiError(
    `Only failed or stuck emails can be requeued (this one is ${job.status.toLowerCase()}).`,
    409
  )
}

export async function listEmailJobsForUser(
  userId: string,
  filters: {
    status?: "PENDING" | "SENDING" | "SENT" | "FAILED"
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
    items: items.map((item) => toEmailJobListItem(item)),
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
      sending: at(EmailJobStatus.SENDING),
      sent: at(EmailJobStatus.SENT),
      failed: at(EmailJobStatus.FAILED),
    },
  }
}

/** Requeues a FAILED job, or a SENDING job stuck past the claim
    lease, back to PENDING (Phase 16, EML-094/095). Owner-scoped:
    the job must belong to the caller. The retry ladder restarts
    (`attempts` reset, `nextAttemptAt = now`) so the owner gets a
    full set of attempts after fixing the cause; `lastError` is kept
    so the failure that prompted the retry stays visible. A SENDING
    job inside the lease is refused (409) — its processor may still
    be alive, and requeueing it could double-send. The automatic
    reclaim of stuck claims is Wave 9's (EML-031); this is the
    manual path from the delivery log. Audit-logged. */
export async function requeueEmailJob(
  userId: string,
  jobId: string
): Promise<EmailJob> {
  const job = await db.emailJob.findUnique({ where: { id: jobId } })
  if (!job || job.ownerId !== userId) {
    throw new ApiError("Email job not found.", 404)
  }
  assertJobRequeueable(job)
  const previousStatus = job.status
  const previousAttempts = job.attempts
  const requeued = await db.emailJob.update({
    where: { id: job.id },
    data: {
      status: EmailJobStatus.PENDING,
      attempts: 0,
      nextAttemptAt: new Date(),
    },
  })
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: job.formId ? AuditResource.FORM : AuditResource.USER,
    resourceId: job.formId ?? userId,
    detail: {
      event: "email-job-requeued",
      emailJobId: job.id,
      previousStatus,
      previousAttempts,
    },
  })
  return requeued
}

// ─── Admin variants (Seven Admin Pages, Phase C, plan §3.6) ────────────
// Same logic as the owner-scoped functions above, admin actor:
// `requireAdmin` + an audit row where the owner variant audits.
// The actor is the permissions package's structural AdminActor plus
// the user id the audit row needs — the permissions package must
// stay free of the auth package, and every AdminSession is
// assignable to this shape.

export type AdminEmailJobActor = AdminActor & { user: { id: string } }

export type AdminEmailJobFilters = {
  /** Status tab (plan §3.6): all / pending / sending / failed. */
  status?: "all" | "pending" | "sending" | "failed"
  type?: EmailJobType
  /** Free text on the job owner (email or name). */
  ownerSearch?: string
  page?: number
}

export type AdminEmailJobListItem = EmailJobListItem & {
  ownerName: string | null
  ownerEmail: string
}

export type AdminEmailJobListResult = Omit<EmailJobListResult, "items"> & {
  items: AdminEmailJobListItem[]
}

const ADMIN_JOB_STATUS_BY_TAB = {
  pending: EmailJobStatus.PENDING,
  sending: EmailJobStatus.SENDING,
  failed: EmailJobStatus.FAILED,
} as const

/** Admin email-job list (Jobs page, Queue section): every owner's
    jobs, newest first, with the same row shape as the owner list
    plus the owner identity. Filters mirror the owner list's shape
    (status, page) extended with type + owner search. Counts are
    computed over the same type/owner-search scope as the rows,
    without the status tab — so the tabs always sum to `all`. */
export async function listEmailJobsForAdmin(
  actor: AdminEmailJobActor,
  filters: AdminEmailJobFilters
): Promise<AdminEmailJobListResult> {
  requireAdmin(actor, "VIEW_JOBS")
  const page = Math.max(1, filters.page ?? 1)
  const status =
    filters.status && filters.status !== "all"
      ? ADMIN_JOB_STATUS_BY_TAB[filters.status]
      : undefined
  const ownerSearch = filters.ownerSearch?.trim() || undefined
  const scopeWhere: Prisma.EmailJobWhereInput = {
    ...(filters.type ? { type: filters.type } : {}),
    ...(ownerSearch
      ? {
          owner: {
            OR: [
              { email: { contains: ownerSearch, mode: "insensitive" } },
              { name: { contains: ownerSearch, mode: "insensitive" } },
            ],
          },
        }
      : {}),
  }
  const where: Prisma.EmailJobWhereInput = {
    ...scopeWhere,
    ...(status ? { status } : {}),
  }
  const [items, total, counts] = await Promise.all([
    db.emailJob.findMany({
      where,
      include: {
        form: { select: { name: true } },
        owner: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * EMAIL_JOB_PAGE_SIZE,
      take: EMAIL_JOB_PAGE_SIZE,
    }),
    db.emailJob.count({ where }),
    db.emailJob.groupBy({
      by: ["status"],
      where: scopeWhere,
      _count: true,
    }),
  ])
  const byStatus = new Map(counts.map((c) => [c.status, c._count]))
  const at = (status: EmailJobStatus) => byStatus.get(status) ?? 0
  return {
    items: items.map((item) => ({
      ...toEmailJobListItem(item),
      ownerName: item.owner.name,
      ownerEmail: item.owner.email,
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
      sending: at(EmailJobStatus.SENDING),
      sent: at(EmailJobStatus.SENT),
      failed: at(EmailJobStatus.FAILED),
    },
  }
}

/** Single-job read for the Jobs detail route — no admin single-job
    read existed before (the owner side has no detail read either;
    the owner delivery log requeues from the list row). */
export async function getEmailJobForAdmin(
  actor: AdminEmailJobActor,
  jobId: string
): Promise<AdminEmailJobListItem> {
  requireAdmin(actor, "VIEW_JOBS")
  const job = await db.emailJob.findUnique({
    where: { id: jobId },
    include: {
      form: { select: { name: true } },
      owner: { select: { name: true, email: true } },
    },
  })
  if (!job) {
    throw new ApiError("Email job not found.", 404)
  }
  return {
    ...toEmailJobListItem(job),
    ownerName: job.owner.name,
    ownerEmail: job.owner.email,
  }
}

/** Admin requeue (Jobs page, Queue section; plan §3.6, Q9):
    MANAGE_JOBS + step-up re-auth. Same outcome as the owner-scoped
    requeue — a FAILED job (or a SENDING job stuck past the 10-min
    claim lease) moves to PENDING with attempts reset and the retry
    ladder restarted; `lastError` is kept. Step-up runs last, after
    every cheap guard, immediately before the write — one password
    entry authorizes exactly one requeue (single-use). Audit-logged
    with the admin actor; the resource is the job's form, else its
    owner (same resource the owner variant records). */
export async function requeueEmailJobForAdmin(
  actor: AdminEmailJobActor,
  jobId: string
): Promise<EmailJob> {
  requireAdmin(actor, "MANAGE_JOBS")
  const job = await db.emailJob.findUnique({ where: { id: jobId } })
  if (!job) {
    throw new ApiError("Email job not found.", 404)
  }
  assertJobRequeueable(job)
  // Step-up (Phase 9): checked last, after every cheap guard,
  // immediately before the write — the admin-users disable pattern.
  // Consumes one unbound admin verification, so one password entry
  // authorizes exactly one requeue.
  await requireStepUp(actor)
  const previousStatus = job.status
  const previousAttempts = job.attempts
  const requeued = await db.emailJob.update({
    where: { id: job.id },
    data: {
      status: EmailJobStatus.PENDING,
      attempts: 0,
      nextAttemptAt: new Date(),
    },
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: job.formId ? AuditResource.FORM : AuditResource.USER,
    resourceId: job.formId ?? job.ownerId,
    detail: {
      event: "email-job-requeued",
      emailJobId: job.id,
      previousStatus,
      previousAttempts,
    },
  })
  return requeued
}

export type DigestState = {
  formId: string
  formName: string
  digestEnabled: boolean
  /** Hours between digests (the form's own value, else the platform
      default). Null only when the platform default itself is unset —
      it never is; kept nullable for the caller's fallback. */
  digestIntervalHours: number
  lastDigestAt: Date | null
  /** When the next digest is due, or null when none has ever been
      sent (the first digest is due on the next run). */
  nextDigestAt: Date | null
}

/** Per-form digest state for the notifications page (Phase 16,
    EML-093/096): the toggle, the interval, and last/next digest —
    one consistent shape with the form detail page's digest section,
    which reads the same fields from `getFormForUser`. */
export async function listDigestStatesForUser(
  userId: string,
  { env = process.env }: { env?: NodeJS.ProcessEnv } = {}
): Promise<DigestState[]> {
  const defaultInterval = getDigestIntervalHours(env)
  const forms = await db.form.findMany({
    where: { ownerId: userId, deletedAt: null },
    select: {
      id: true,
      name: true,
      digestEnabled: true,
      digestIntervalHours: true,
      lastDigestAt: true,
    },
    orderBy: { createdAt: "asc" },
  })
  return forms.map((form) => {
    const intervalHours = form.digestIntervalHours ?? defaultInterval
    return {
      formId: form.id,
      formName: form.name,
      digestEnabled: form.digestEnabled,
      digestIntervalHours: intervalHours,
      lastDigestAt: form.lastDigestAt,
      nextDigestAt: getNextDigestAt(form.lastDigestAt, intervalHours),
    }
  })
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
  const locale = (await ownerLocale(userId)) ?? "en"
  const t = getEmailTranslator(locale)
  const subject = t("testSubject", { formName: form.name })
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
    footerText: t("testFooter"),
    locale,
  }
  const { html, text } = await notificationDeps.renderNotification(props)
  try {
    const { messageId, provider } = await notificationDeps.sendEmail({
      to,
      subject,
      html,
      text,
    })
    // EML-096: a test send leaves a trace — a SENT row in the
    // delivery log (type TEST_EMAIL), so the owner can see recent
    // test sends alongside real ones. Best-effort: the email is
    // already sent, so a failed record must not turn a success into
    // an error — it is logged instead.
    try {
      await db.emailJob.create({
        data: {
          type: EmailJobType.TEST_EMAIL,
          to,
          subject,
          status: EmailJobStatus.SENT,
          providerMessageId: messageId,
          formId: form.id,
          ownerId: userId,
        },
      })
    } catch (err) {
      logger.error("test email history record failed", {
        error: err,
        formId,
        to,
      })
    }
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
