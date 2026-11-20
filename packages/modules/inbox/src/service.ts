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
  getSubmissionSender,
  previewSubmissionText,
} from "@sendcms/shared"
import {
  draftReply,
  getAiModel,
  isAiConfigured,
  type ReplyDraft,
} from "@sendcms/ai"
import { enqueueReply } from "@sendcms/notifications"

// ---------------------------------------------------------------------------
// Inbox dashboard. Admin-side reads and status changes.
// Isolation rule: a Submission has no ownerId of its own — every query
// scopes through its Form (form.ownerId = the viewer). A submission
// whose form belongs to someone else is invisible, not just forbidden.

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

function buildInboxWhere(
  userId: string,
  filters: InboxFilters,
  includeStatus: boolean
): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`f."ownerId" = ${userId}`]
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
  const page = Math.max(1, filters.page ?? 1)
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
      JOIN "Form" f ON f.id = s."formId"
      WHERE ${buildInboxWhere(userId, filters, true)}
    `),
    db.$queryRaw<{ status: SubmissionStatus; n: number }[]>(Prisma.sql`
      SELECT s.status, COUNT(*)::int AS n
      FROM "Submission" s
      JOIN "Form" f ON f.id = s."formId"
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

export async function getSubmissionForUser(
  userId: string,
  submissionId: string
): Promise<InboxSubmissionDetail> {
  const submission = await db.submission.findFirst({
    where: { id: submissionId, form: { ownerId: userId } },
    include: {
      form: { select: { id: true, name: true, aiEnabled: true } },
      events: {
        orderBy: { createdAt: "desc" },
        include: { actor: { select: { name: true, email: true } } },
      },
    },
  })
  if (!submission) {
    throw new ApiError("Submission not found.", 404)
  }
  return submission
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
  // the AuditLog row is the cross-resource trail.
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.SUBMISSION,
    resourceId: submissionId,
    detail: { action, status: result.status, changed: result.changed },
  })
  return result
}

export async function bulkUpdateSubmissionsForUser(
  userId: string,
  submissionIds: string[],
  action: InboxAction
): Promise<{ updated: number; skipped: number }> {
  const result = await db.$transaction(async (tx) => {
    const submissions = await tx.submission.findMany({
      where: {
        id: { in: submissionIds },
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
    // Ids that don't exist or belong to someone else are skipped
    // silently — the caller never learns whether they exist.
    skipped += submissionIds.length - submissions.length
    return { updated, skipped }
  })
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.SUBMISSION,
    resourceId: submissionIds.join(","),
    detail: { action, submissionIds, ...result },
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
    where: { status: SubmissionStatus.NEW, form: { ownerId: userId } },
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

function requireAiForForm(
  form: { aiEnabled: boolean },
  env: NodeJS.ProcessEnv
): void {
  if (!form.aiEnabled) {
    throw new ApiError(
      "AI is not enabled for this form. Enable it in the form settings first.",
      403
    )
  }
  if (!isAiConfigured(env)) {
    throw new ApiError(
      "No AI provider is configured. Set a provider key first.",
      503
    )
  }
}

/** Drafts a reply to one submission. Returns the draft — nothing is
    sent. Throws 403 when AI is off for the form, 503 when no provider
    is configured. */
export async function draftReplyForSubmission(
  userId: string,
  submissionId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ReplyDraft> {
  const submission = await getOwnedSubmissionWithFormOrThrow(
    userId,
    submissionId
  )
  requireAiForForm(submission.form, env)
  const sender = getSubmissionSender(submission.data)
  return draftReply({
    model: getAiModel(env),
    formName: submission.form.name,
    submission: {
      senderName: sender.name,
      senderEmail: sender.email,
      content: previewSubmissionText(submission.data),
      receivedAt: submission.createdAt,
    },
  })
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
  await db.submissionEvent.create({
    data: {
      submissionId: submission.id,
      type: SubmissionEventType.EMAIL_SENT,
      detail: { reply: true },
      actorId: userId,
    },
  })
  return { enqueued }
}
