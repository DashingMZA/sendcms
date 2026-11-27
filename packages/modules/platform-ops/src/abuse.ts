import type { AdminSession } from "@sendcms/auth"
import {
  AuditAction,
  AuditResource,
  Prisma,
  SubmissionStatus,
  db,
} from "@sendcms/database"
import { resolveStatusAction, type InboxAction } from "@sendcms/inbox"
import { logAudit } from "@sendcms/security"
import { ApiError } from "@sendcms/shared"
import type {
  PlatformSubmissionsQuery,
  UpdatePlatformSubmissionStatusInput,
} from "./validators"
import { requireAdmin, type AuditOpts } from "./require-admin"

// Abuse / spam queue (Admin Control Plane, Phase 7).
// Framework-independent (no Next.js imports); only services import
// @sendcms/database. Authorization lives HERE, not in the routes.
//
// The list is METADATA ONLY — never the submission `data` (which may
// hold PII). The full submission is a separate call that needs
// VIEW_SENSITIVE_SUBMISSIONS and is audit-logged like Phase 3's
// getUserSubmission. Status changes reuse the inbox's own transition
// rules (resolveStatusAction): a restore lands on READ, never on
// NEW, and an illegal transition is a no-op, not an error.

export type PlatformSubmissionRow = {
  id: string
  status: SubmissionStatus
  originDomain: string
  pageUrl: string | null
  createdAt: Date
  updatedAt: Date
  form: {
    id: string
    name: string
    ownerId: string
    owner: { id: string; name: string | null; email: string } | null
  }
}

const platformSubmissionSelect = {
  id: true,
  status: true,
  originDomain: true,
  pageUrl: true,
  createdAt: true,
  updatedAt: true,
  form: {
    select: {
      id: true,
      name: true,
      ownerId: true,
      owner: { select: { id: true, name: true, email: true } },
    },
  },
} as const

function platformSubmissionsWhere(
  filters: PlatformSubmissionsQuery
): Prisma.SubmissionWhereInput {
  const and: Prisma.SubmissionWhereInput[] = []
  if (filters.status) and.push({ status: filters.status })
  if (filters.formId) and.push({ formId: filters.formId })
  if (filters.userId) and.push({ form: { ownerId: filters.userId } })
  const createdAt: Prisma.DateTimeFilter = {}
  if (filters.from) {
    const d = new Date(filters.from)
    if (!Number.isNaN(d.getTime())) createdAt.gte = d
  }
  if (filters.to) {
    const d = new Date(filters.to)
    if (!Number.isNaN(d.getTime())) createdAt.lte = d
  }
  if (Object.keys(createdAt).length > 0) and.push({ createdAt })
  const search = filters.search?.trim()
  if (search) {
    and.push({
      OR: [
        { originDomain: { contains: search, mode: "insensitive" } },
        { pageUrl: { contains: search, mode: "insensitive" } },
        { form: { name: { contains: search, mode: "insensitive" } } },
        {
          form: {
            owner: { email: { contains: search, mode: "insensitive" } },
          },
        },
      ],
    })
  }
  return and.length > 0 ? { AND: and } : {}
}

/** Platform-wide submissions, metadata only, newest first. Reads
    need VIEW_CUSTOMER_DATA (support staff triage the queue; the
    `data` field is never selected here). */
export async function listPlatformSubmissions(
  actor: AdminSession,
  filters: PlatformSubmissionsQuery
): Promise<{
  submissions: PlatformSubmissionRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "VIEW_CUSTOMER_DATA")
  const where = platformSubmissionsWhere(filters)
  const [total, rows] = await Promise.all([
    db.submission.count({ where }),
    db.submission.findMany({
      where,
      select: platformSubmissionSelect,
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.perPage,
      take: filters.perPage,
    }),
  ])
  return {
    submissions: rows,
    total,
    page: filters.page,
    perPage: filters.perPage,
    totalPages: Math.max(1, Math.ceil(total / filters.perPage)),
  }
}

export type PlatformSubmissionDetail = PlatformSubmissionRow & {
  data: Prisma.JsonValue
  events: {
    id: string
    type: string
    detail: Prisma.JsonValue | null
    createdAt: Date
    actor: { name: string | null; email: string } | null
  }[]
  /** DB-046: total event count (the `events` page is capped). */
  eventCount: number
  /** DB-046: true when older events exist beyond the returned page. */
  hasMoreEvents: boolean
}

/** One submission WITH its `data`. Needs VIEW_SENSITIVE_SUBMISSIONS,
    and the access is audit-logged BEFORE the return (the Phase 3
    convention) — the row records who looked at whose submission. */
export async function getPlatformSubmission(
  actor: AdminSession,
  submissionId: string,
  opts: AuditOpts = {}
): Promise<PlatformSubmissionDetail> {
  requireAdmin(actor, "VIEW_SENSITIVE_SUBMISSIONS")
  const [row, eventCount] = await Promise.all([
    db.submission.findUnique({
      where: { id: submissionId },
      include: {
        form: {
          select: {
            id: true,
            name: true,
            ownerId: true,
            owner: { select: { id: true, name: true, email: true } },
          },
        },
        events: {
          // DB-046: newest 50 only — the full event history used to
          // load on every sensitive-submission read.
          orderBy: { createdAt: "desc" },
          take: 50,
          include: { actor: { select: { name: true, email: true } } },
        },
      },
    }),
    db.submissionEvent.count({ where: { submissionId } }),
  ])
  if (!row) throw new ApiError("Submission not found.", 404)
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.SUBMISSION,
    resourceId: submissionId,
    detail: {
      event: "sensitive-submission-access",
      formId: row.formId,
      ownerId: row.form.ownerId,
    },
    correlationId: opts.correlationId,
  })
  return {
    ...row,
    eventCount,
    hasMoreEvents: eventCount > row.events.length,
  }
}

export type SpamStats = {
  byStatus: { status: SubmissionStatus; count: number }[]
  topSpamForms: {
    formId: string
    formName: string
    ownerEmail: string
    spamCount: number
  }[]
  topSubmitters: {
    userId: string
    name: string | null
    email: string
    submissionsLast30Days: number
  }[]
}

/** Spam counts by status, the top-5 forms by SPAM count, and the
    top-5 users by submission volume in the last 30 days. Counts only
    (groupBy, no N+1). Reads need VIEW_CUSTOMER_DATA. */
export async function getSpamStats(actor: AdminSession): Promise<SpamStats> {
  requireAdmin(actor, "VIEW_CUSTOMER_DATA")
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const [byStatus, spamForms, recentByForm] = await Promise.all([
    db.submission.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    db.submission.groupBy({
      by: ["formId"],
      where: { status: "SPAM" },
      _count: { _all: true },
      orderBy: { _count: { formId: "desc" } },
      take: 5,
    }),
    db.submission.groupBy({
      by: ["formId"],
      where: { createdAt: { gte: thirtyDaysAgo } },
      _count: { _all: true },
      orderBy: { _count: { formId: "desc" } },
    }),
  ])
  const formIds = [
    ...new Set([...spamForms, ...recentByForm].map((g) => g.formId)),
  ]
  const forms = await db.form.findMany({
    where: { id: { in: formIds } },
    select: {
      id: true,
      name: true,
      ownerId: true,
      owner: { select: { id: true, name: true, email: true } },
    },
  })
  const formById = new Map(forms.map((f) => [f.id, f]))
  const topSpamForms = spamForms.map((g) => {
    const form = formById.get(g.formId)
    return {
      formId: g.formId,
      formName: form?.name ?? "unknown",
      ownerEmail: form?.owner?.email ?? "unknown",
      spamCount: g._count._all,
    }
  })
  // Submissions carry no ownerId of their own — volume is counted
  // per form, then summed per owner in code.
  const byOwner = new Map<string, number>()
  for (const g of recentByForm) {
    const ownerId = formById.get(g.formId)?.ownerId
    if (!ownerId) continue
    byOwner.set(ownerId, (byOwner.get(ownerId) ?? 0) + g._count._all)
  }
  const topOwnerIds = [...byOwner.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  const owners = await db.user.findMany({
    where: { id: { in: topOwnerIds.map(([id]) => id) } },
    select: { id: true, name: true, email: true },
  })
  const ownerById = new Map(owners.map((u) => [u.id, u]))
  const topSubmitters = topOwnerIds.map(([userId, count]) => {
    const user = ownerById.get(userId)
    return {
      userId,
      name: user?.name ?? null,
      email: user?.email ?? "unknown",
      submissionsLast30Days: count,
    }
  })
  return {
    byStatus: byStatus.map((g) => ({
      status: g.status,
      count: g._count._all,
    })),
    topSpamForms,
    topSubmitters,
  }
}

// The admin sets the target status; the inbox action is derived so
// the transition rules stay the inbox's. A restore lands on READ.
function actionForTargetStatus(
  target: "NEW" | "SPAM" | "ARCHIVED",
  current: SubmissionStatus
): InboxAction {
  if (target === "SPAM") return "spam"
  if (target === "ARCHIVED") return "archive"
  if (current === SubmissionStatus.SPAM) return "not-spam"
  if (current === SubmissionStatus.ARCHIVED) return "restore"
  return "unread"
}

/** Changes one submission's status from the abuse queue. MANAGE_USERS,
    reason required, audited with old/new. The status update and the
    SubmissionEvent write in ONE transaction; an illegal transition
    is a no-op (changed: false) — the inbox's idempotency rule. */
export async function updatePlatformSubmissionStatus(
  actor: AdminSession,
  submissionId: string,
  input: UpdatePlatformSubmissionStatusInput,
  opts: AuditOpts = {}
): Promise<{ id: string; status: SubmissionStatus; changed: boolean }> {
  requireAdmin(actor, "MANAGE_USERS")
  const result = await db.$transaction(async (tx) => {
    const submission = await tx.submission.findUnique({
      where: { id: submissionId },
      select: { id: true, status: true, formId: true },
    })
    if (!submission) {
      throw new ApiError("Submission not found.", 404)
    }
    const action = actionForTargetStatus(input.status, submission.status)
    const transition = resolveStatusAction(action, submission.status)
    if (!transition) {
      return { id: submission.id, status: submission.status, changed: false }
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
        actorId: actor.user.id,
      },
    })
    return { id: submission.id, status: transition.status, changed: true }
  })
  // SRC-236: a no-op transition (already in the target state) writes
  // no audit row — it used to log `changed: false` noise on every
  // redundant call from the abuse queue.
  if (result.changed) {
    await logAudit({
      userId: actor.user.id,
      action: AuditAction.UPDATE,
      resourceType: AuditResource.SUBMISSION,
      resourceId: submissionId,
      detail: {
        event: "platform-submission-status-changed",
        reason: input.reason,
        requestedStatus: input.status,
        status: result.status,
        changed: result.changed,
      },
      reason: input.reason,
      correlationId: opts.correlationId,
    })
  }
  return result
}
