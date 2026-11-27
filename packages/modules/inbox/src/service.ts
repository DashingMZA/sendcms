import {
  AuditAction,
  AuditResource,
  Prisma,
  SubmissionEventType,
  SubmissionStatus,
  db,
} from "@sendcms/database"
import { logAudit } from "@sendcms/security"
import {
  ApiError,
  aiSubmissionExcerpt,
  getSubmissionSender,
} from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"
import {
  draftReply,
  isAiAuthFailure,
  mapAiCallError,
  type AiCallUsage,
  type AiEnvConfig,
  type AiProviderName,
  type ReplyDraft,
} from "@sendcms/ai"
import {
  claimInteractiveAiCall,
  recordAiUsage,
  recordByokAuthFailure,
  recordByokAuthSuccess,
  resolveAiModelForUser,
} from "@sendcms/ai-settings"
import { enqueueReply } from "@sendcms/notifications"
import { isValidCalendarDate } from "./validators"

const logger = createLogger("inbox")

// ---------------------------------------------------------------------------
// Inbox dashboard. Admin-side reads and status changes.
// Isolation rule: a Submission carries its owner's id denormalized
// (ownerId, set from form.ownerId at create time — PRF-011, Phase 16,
// Wave 3), and every owner-scoped query filters on it directly instead
// of joining Form. A submission whose ownerId is someone else's is
// invisible, not just forbidden. The list query still joins Form, but
// only to read the form's name for display — never to scope the rows.

export const INBOX_PAGE_SIZE = 20

export type InboxTab =
  "all" | "unread" | "read" | "starred" | "archived" | "spam"

export type InboxAction =
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "archive"
  | "restore"
  | "spam"
  | "not-spam"

export type InboxFilters = {
  tab?: InboxTab
  formId?: string
  originDomain?: string
  search?: string
  /** Inclusive, YYYY-MM-DD. */
  from?: string
  /** Inclusive, YYYY-MM-DD. */
  to?: string
  page?: number
}

/** Sender details pulled out of the submission's field values. Keys are
    matched case-insensitively; anything else falls back to null. */
export { getSubmissionSender }

type StatusTransition = {
  status: SubmissionStatus
  event: SubmissionEventType
}

/** Maps an inbox action to its target status + event, or null when the
    action is a no-op for the current status (idempotent — the caller
    returns the submission unchanged and writes no event). Archived and
    spam submissions must be restored before any other action. */
export function resolveStatusAction(
  action: InboxAction,
  current: SubmissionStatus
): StatusTransition | null {
  switch (action) {
    case "read":
      return current === SubmissionStatus.NEW
        ? { status: SubmissionStatus.READ, event: SubmissionEventType.READ }
        : null
    case "unread":
      return current === SubmissionStatus.READ ||
        current === SubmissionStatus.STARRED
        ? { status: SubmissionStatus.NEW, event: SubmissionEventType.UNREAD }
        : null
    case "star":
      return current === SubmissionStatus.NEW ||
        current === SubmissionStatus.READ
        ? {
            status: SubmissionStatus.STARRED,
            event: SubmissionEventType.STARRED,
          }
        : null
    case "unstar":
      return current === SubmissionStatus.STARRED
        ? {
            status: SubmissionStatus.READ,
            event: SubmissionEventType.UNSTARRED,
          }
        : null
    case "archive":
      return current === SubmissionStatus.NEW ||
        current === SubmissionStatus.READ ||
        current === SubmissionStatus.STARRED
        ? {
            status: SubmissionStatus.ARCHIVED,
            event: SubmissionEventType.ARCHIVED,
          }
        : null
    case "restore":
      return current === SubmissionStatus.ARCHIVED ||
        current === SubmissionStatus.SPAM
        ? {
            status: SubmissionStatus.READ,
            event: SubmissionEventType.RESTORED,
          }
        : null
    case "spam":
      return current === SubmissionStatus.NEW ||
        current === SubmissionStatus.READ ||
        current === SubmissionStatus.STARRED
        ? {
            status: SubmissionStatus.SPAM,
            event: SubmissionEventType.MARKED_SPAM,
          }
        : null
    case "not-spam":
      return current === SubmissionStatus.SPAM
        ? {
            status: SubmissionStatus.READ,
            event: SubmissionEventType.RESTORED,
          }
        : null
  }
}

type InboxRow = {
  id: string
  data: Prisma.JsonValue
  status: SubmissionStatus
  originDomain: string
  ipAddress: string | null
  userAgent: string | null
  pageUrl: string | null
  createdAt: Date
  updatedAt: Date
  formId: string
  formName: string
}

export type InboxListItem = InboxRow & {
  sender: { name: string | null; email: string | null }
}

export type InboxCounts = Record<InboxTab, number>

export type InboxListResult = {
  items: InboxListItem[]
  total: number
  page: number
  pageSize: number
  counts: InboxCounts
}

function tabStatuses(tab: InboxTab): SubmissionStatus[] | null {
  switch (tab) {
    case "all":
      return [
        SubmissionStatus.NEW,
        SubmissionStatus.READ,
        SubmissionStatus.STARRED,
      ]
    case "unread":
      return [SubmissionStatus.NEW]
    case "read":
      return [SubmissionStatus.READ]
    case "starred":
      return [SubmissionStatus.STARRED]
    case "archived":
      return [SubmissionStatus.ARCHIVED]
    case "spam":
      return [SubmissionStatus.SPAM]
  }
}

function assertValidDateFilter(
  value: string | undefined,
  field: "from" | "to"
): void {
  if (value === undefined) return
  if (!isValidCalendarDate(value)) {
    throw new ApiError(
      `Invalid ${field} date. Expected a valid calendar date (YYYY-MM-DD).`,
      422
    )
  }
}

function buildInboxWhere(
  userId: string,
  filters: InboxFilters,
  includeStatus: boolean
): Prisma.Sql {
  // PRF-011 (Phase 16, Wave 3): scope on the denormalized
  // s."ownerId" — served by @@index([ownerId, status, createdAt]) /
  // @@index([ownerId, createdAt]) — never through the Form join.
  const parts: Prisma.Sql[] = [Prisma.sql`s."ownerId" = ${userId}`]
  if (includeStatus) {
    const statuses = tabStatuses(filters.tab ?? "all")
    if (statuses) {
      parts.push(Prisma.sql`s.status = ANY(${statuses}::"SubmissionStatus"[])`)
    }
  }
  if (filters.formId) {
    parts.push(Prisma.sql`s."formId" = ${filters.formId}`)
  }
  if (filters.originDomain) {
    parts.push(Prisma.sql`s."originDomain" = ${filters.originDomain}`)
  }
  if (filters.from) {
    parts.push(Prisma.sql`s."createdAt" >= ${filters.from}::timestamptz`)
  }
  if (filters.to) {
    // Inclusive end of day.
    parts.push(
      Prisma.sql`s."createdAt" < (${filters.to}::date + interval '1 day')`
    )
  }
  const search = filters.search?.trim()
  if (search) {
    const like = `%${search}%`
    parts.push(
      Prisma.sql`(s."originDomain" ILIKE ${like} OR s."pageUrl" ILIKE ${like} OR s."data"::text ILIKE ${like})`
    )
  }
  return Prisma.join(parts, " AND ")
}

const INBOX_SELECT = Prisma.sql`
  s.id, s.data, s.status, s."originDomain", s."ipAddress", s."userAgent",
  s."pageUrl", s."createdAt", s."updatedAt",
  f.id AS "formId", f.name AS "formName"
  FROM "Submission" s
  JOIN "Form" f ON f.id = s."formId"
`

export async function listSubmissionsForUser(
  userId: string,
  filters: InboxFilters
): Promise<InboxListResult> {
  // DSH-202: the route validates the shape, but direct service
  // callers (MCP tools, server components) can pass impossible dates
  // that Postgres rejects as a cast error (500). Fail with a 422
  // here instead — the codebase's rule for bad filter values
  // (SRC-231). `from > to` stays defined (empty result, as today).
  assertValidDateFilter(filters.from, "from")
  assertValidDateFilter(filters.to, "to")
  // DB-048: clamp the page for direct service callers (the route's
  // Zod schema caps it too) — page 100000 used to yield a ~2M-row
  // offset scan on this raw-SQL list. Beyond 1000 the deepest page
  // is served instead of a deeper scan.
  const page = Math.min(1000, Math.max(1, filters.page ?? 1))
  const offset = (page - 1) * INBOX_PAGE_SIZE

  const [rows, totalRows, countRows] = await Promise.all([
    db.$queryRaw<InboxRow[]>(Prisma.sql`
      SELECT ${INBOX_SELECT}
      WHERE ${buildInboxWhere(userId, filters, true)}
      ORDER BY s."createdAt" DESC
      LIMIT ${INBOX_PAGE_SIZE} OFFSET ${offset}
    `),
    db.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n
      FROM "Submission" s
      WHERE ${buildInboxWhere(userId, filters, true)}
    `),
    db.$queryRaw<{ status: SubmissionStatus; n: number }[]>(Prisma.sql`
      SELECT s.status, COUNT(*)::int AS n
      FROM "Submission" s
      WHERE ${buildInboxWhere(userId, filters, false)}
      GROUP BY s.status
    `),
  ])

  const byStatus = new Map<SubmissionStatus, number>()
  for (const row of countRows) byStatus.set(row.status, row.n)
  const at = (status: SubmissionStatus) => byStatus.get(status) ?? 0
  const counts: InboxCounts = {
    all:
      at(SubmissionStatus.NEW) +
      at(SubmissionStatus.READ) +
      at(SubmissionStatus.STARRED),
    unread: at(SubmissionStatus.NEW),
    read: at(SubmissionStatus.READ),
    starred: at(SubmissionStatus.STARRED),
    archived: at(SubmissionStatus.ARCHIVED),
    spam: at(SubmissionStatus.SPAM),
  }

  return {
    items: rows.map((row) => ({
      ...row,
      sender: getSubmissionSender(row.data),
    })),
    total: totalRows[0]?.n ?? 0,
    page,
    pageSize: INBOX_PAGE_SIZE,
    counts,
  }
}

export type InboxSubmissionDetail = Prisma.SubmissionGetPayload<{
  include: {
    form: { select: { id: true; name: true; aiEnabled: true } }
    events: {
      include: { actor: { select: { name: true; email: true } } }
    }
  }
}>

// DB-046: at most this many history events on a submission detail
// read, newest first. A long-lived submission's event history used
// to load in full on every detail read.
export const SUBMISSION_EVENTS_MAX = 50

export async function getSubmissionForUser(
  userId: string,
  submissionId: string
): Promise<
  InboxSubmissionDetail & { eventCount: number; hasMoreEvents: boolean }
> {
  const [submission, eventCount] = await Promise.all([
    db.submission.findFirst({
      where: { id: submissionId, form: { ownerId: userId } },
      include: {
        form: { select: { id: true, name: true, aiEnabled: true } },
        events: {
          orderBy: { createdAt: "desc" },
          take: SUBMISSION_EVENTS_MAX,
          include: { actor: { select: { name: true, email: true } } },
        },
      },
    }),
    db.submissionEvent.count({ where: { submissionId } }),
  ])
  if (!submission) {
    throw new ApiError("Submission not found.", 404)
  }
  return {
    ...submission,
    eventCount,
    hasMoreEvents: eventCount > submission.events.length,
  }
}

async function applyStatusAction(
  tx: Prisma.TransactionClient,
  submission: { id: string; status: SubmissionStatus },
  action: InboxAction,
  actorId: string
): Promise<{ changed: boolean; status: SubmissionStatus }> {
  const transition = resolveStatusAction(action, submission.status)
  if (!transition) {
    return { changed: false, status: submission.status }
  }
  await tx.submission.update({
    where: { id: submission.id },
    data: { status: transition.status },
  })
  await tx.submissionEvent.create({
    data: {
      type: transition.event,
      detail: {
        action,
        from: submission.status,
        to: transition.status,
      },
      submissionId: submission.id,
      actorId,
    },
  })
  return { changed: true, status: transition.status }
}

export async function updateSubmissionStatusForUser(
  userId: string,
  submissionId: string,
  action: InboxAction
): Promise<{ id: string; status: SubmissionStatus; changed: boolean }> {
  const result = await db.$transaction(async (tx) => {
    const submission = await tx.submission.findFirst({
      where: { id: submissionId, form: { ownerId: userId } },
      select: { id: true, status: true },
    })
    if (!submission) {
      throw new ApiError("Submission not found.", 404)
    }
    const result = await applyStatusAction(tx, submission, action, userId)
    return { id: submission.id, ...result }
  })
  // Audit after the transaction commits (best-effort — logAudit never
  // throws). The per-action SubmissionEvent already records the change;
  // the AuditLog row is the cross-resource trail. SRC-236: a no-op
  // transition (already in the target state) writes no audit row —
  // it used to log `changed: false` noise on every redundant call.
  if (result.changed) {
    await logAudit({
      userId,
      action: AuditAction.UPDATE,
      resourceType: AuditResource.SUBMISSION,
      resourceId: submissionId,
      detail: { action, status: result.status, changed: result.changed },
    })
  }
  return result
}

export async function bulkUpdateSubmissionsForUser(
  userId: string,
  submissionIds: string[],
  action: InboxAction
): Promise<{ updated: number; skipped: number; notFound: number }> {
  // SRC-236: dedupe the ids first — a duplicated id used to count
  // twice (once found, once in `notFound`), so `skipped`/`notFound`
  // miscounted. The validator still caps the raw list at 100.
  const ids = [...new Set(submissionIds)]
  const result = await db.$transaction(async (tx) => {
    const submissions = await tx.submission.findMany({
      where: {
        id: { in: ids },
        form: { ownerId: userId },
      },
      select: { id: true, status: true },
    })
    let updated = 0
    let skipped = 0
    for (const submission of submissions) {
      const result = await applyStatusAction(tx, submission, action, userId)
      if (result.changed) updated++
      else skipped++
    }
    // AIM-011: ids that don't exist (or belong to someone else) used
    // to be folded into `skipped`, so a bulk call with only bogus ids
    // returned a silent SUCCESS (`updated: 0, skipped: 1`) that was
    // indistinguishable from "already in the target state". They are
    // now reported as `notFound` — a count only, never which ids, so
    // the cross-owner invisibility rule still holds.
    const notFound = ids.length - submissions.length
    return { updated, skipped, notFound }
  })
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.SUBMISSION,
    resourceId: ids.join(","),
    detail: { action, submissionIds: ids, ...result },
  })
  return result
}

export async function deleteSubmissionForUser(
  userId: string,
  submissionId: string
): Promise<void> {
  const deleted = await db.submission.deleteMany({
    where: { id: submissionId, form: { ownerId: userId } },
  })
  if (deleted.count === 0) {
    throw new ApiError("Submission not found.", 404)
  }
  await logAudit({
    userId,
    action: AuditAction.DELETE,
    resourceType: AuditResource.SUBMISSION,
    resourceId: submissionId,
  })
}

export async function getUnreadSubmissionCountForUser(
  userId: string
): Promise<number> {
  return db.submission.count({
    where: { status: SubmissionStatus.NEW, ownerId: userId },
  })
}

// ---------------------------------------------------------------------------
// Auto-reply drafts (Phase 12, Step 4)
// ---------------------------------------------------------------------------
// Dashboard-initiated: the owner asks for a draft, the model writes it,
// the owner reviews and edits it before anything is sent. The draft
// function only returns a draft; the send function enqueues the
// owner's (edited) words through the outbox.

async function getOwnedSubmissionWithFormOrThrow(
  userId: string,
  submissionId: string
) {
  const submission = await db.submission.findFirst({
    where: { id: submissionId, form: { ownerId: userId } },
    include: {
      form: { select: { id: true, name: true, aiEnabled: true } },
    },
  })
  if (!submission) {
    throw new ApiError("Submission not found.", 404)
  }
  return submission
}

function requireAiForForm(form: { aiEnabled: boolean }): void {
  if (!form.aiEnabled) {
    throw new ApiError(
      "AI is not enabled for this form. Enable it in the form settings first.",
      403
    )
  }
  // No provider check here — the resolver owns availability (BYOK,
  // browser-only, or platform key) and throws its own 503.
}

/** Drafts a reply to one submission. Returns the draft — nothing is
    sent. Throws 403 when AI is off for the form, 503 when no provider
    is configured. The model is resolved for the submission's OWNER;
    `opts` carries an optional per-request browser-only key, which is
    never stored. `aiEnv` is the explicit AI config built from the
    route (SRC-123) — never the whole process.env. */
export async function draftReplyForSubmission(
  userId: string,
  submissionId: string,
  aiEnv: AiEnvConfig,
  opts: {
    provider?: AiProviderName
    browserKey?: string
    browserModel?: string
  } = {}
): Promise<ReplyDraft> {
  const submission = await getOwnedSubmissionWithFormOrThrow(
    userId,
    submissionId
  )
  requireAiForForm(submission.form)
  let resolved
  try {
    resolved = await resolveAiModelForUser(userId, {
      purpose: "draft-reply",
      resourceId: submissionId,
      provider: opts.provider,
      browserKey: opts.browserKey,
      browserModel: opts.browserModel,
      env: aiEnv,
    })
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError("AI is not available right now. Try again later.", 503)
  }
  const sender = getSubmissionSender(submission.data)
  const usage: { current: AiCallUsage | null } = { current: null }
  // AIM-028: same daily-budget claim as suggest-fields — claimed
  // after resolution, before the model call; 429 at the cap.
  if (!(await claimInteractiveAiCall(userId))) {
    throw new ApiError(
      "You have reached your daily AI limit. Try again tomorrow.",
      429
    )
  }
  let draft
  try {
    draft = await draftReply({
      model: resolved.model,
      formName: submission.form.name,
      submission: {
        senderName: sender.name,
        senderEmail: sender.email,
        // AIM-019: the model sees a real excerpt (up to 2000
        // chars), not the 80-char UI preview.
        content: aiSubmissionExcerpt(submission.data, 2000),
        receivedAt: submission.createdAt,
      },
      onUsage: (u) => {
        usage.current = u
      },
    })
  } catch (err) {
    // AIM-003: a provider-auth failure at call time feeds the BYOK
    // key's auto-disable counter (transient failures never do).
    if (resolved.billingMode === "BYOK" && isAiAuthFailure(err)) {
      await recordByokAuthFailure(userId, resolved.provider)
    }
    await recordAiUsage({
      userId,
      provider: resolved.provider,
      model: resolved.modelId,
      billingMode: resolved.billingMode,
      status: "FAILED",
      sourceEvent: "draft-reply",
      resourceId: submissionId,
    })
    // AIM-004 / AIM-023 / SRC-225: map the raw SDK error to a
    // 502/503 naming the failure class instead of a generic 500.
    throw mapAiCallError(err, resolved.provider)
  }
  // SRC-225: guarded like suggest-fields — a bookkeeping failure
  // must never discard a good draft.
  try {
    await recordAiUsage({
      userId,
      provider: resolved.provider,
      model: resolved.modelId,
      billingMode: resolved.billingMode,
      status: "SUCCESS",
      tokensIn: usage.current?.promptTokens ?? null,
      tokensOut: usage.current?.completionTokens ?? null,
      costMicros: usage.current?.costMicros ?? null,
      sourceEvent: "draft-reply",
      resourceId: submissionId,
    })
  } catch (err) {
    logger.error("ai usage record failed after successful draft-reply", {
      error: err,
      userId,
      submissionId,
    })
  }
  if (resolved.billingMode === "BYOK") {
    await recordByokAuthSuccess(userId, resolved.provider)
  }
  return draft
}

/** Sends the owner's reply to a submission's sender through the
    outbox. The body is the owner's own (reviewed and edited) words —
    the model is never involved in the send. Returns how many jobs
    were enqueued. */
export async function sendReplyToSubmission(
  userId: string,
  submissionId: string,
  input: { subject: string; body: string }
): Promise<{ enqueued: number }> {
  const submission = await getOwnedSubmissionWithFormOrThrow(
    userId,
    submissionId
  )
  const sender = getSubmissionSender(submission.data)
  if (!sender.email) {
    throw new ApiError("This submission has no email address to reply to.", 422)
  }
  const subject = input.subject.trim()
  const body = input.body.trim()
  if (!subject || !body) {
    throw new ApiError("Subject and body are both required.", 422)
  }
  if (subject.length > 200 || body.length > 2000) {
    throw new ApiError("Reply is too long.", 422)
  }
  const enqueued = await enqueueReply({
    formId: submission.formId,
    submissionId: submission.id,
    to: sender.email,
    subject,
    body,
    formName: submission.form.name,
  })
  // SRC-217: the reply is only QUEUED at this point — record an
  // EMAIL_QUEUED timeline event (with the actor: the owner who sent
  // it), never EMAIL_SENT. processOneJob writes EMAIL_SENT when the
  // provider accepts the job (and EMAIL_FAILED on terminal failure),
  // so the timeline never claims a delivery that never happened.
  // Best-effort: the job is already durably queued, and a timeline
  // write must never fail the send — it is logged instead.
  if (enqueued > 0) {
    try {
      await db.submissionEvent.create({
        data: {
          type: SubmissionEventType.EMAIL_QUEUED,
          detail: { reply: true, queued: true },
          submissionId: submission.id,
          actorId: userId,
        },
      })
    } catch (err) {
      logger.error("reply queued event failed after successful enqueue", {
        error: err,
        userId,
        submissionId: submission.id,
      })
    }
  }
  return { enqueued }
}
