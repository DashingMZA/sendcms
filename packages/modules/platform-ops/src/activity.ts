import type { AdminSession } from "@sendcms/auth"
import {
  AuditOutcome,
  AuditResource,
  BillingEventKind,
  Prisma,
  SubmissionEventType,
  SubscriptionEventType,
  db,
} from "@sendcms/database"
import { ApiError } from "@sendcms/shared"
import type { ActivityFeedQuery } from "./validators"
import { requireAdmin } from "./require-admin"

// Unified activity feed (Seven Admin Pages, Phase B, plan §3.1).
// Framework-independent (no Next.js imports); only services import
// @sendcms/database. Read-only: no mutation, no audit write —
// reading the feed never writes a row.
//
// The feed merges four append-only sources by createdAt, newest
// first, into one common row shape. Cursor pagination on createdAt
// (mixed sources cannot share one OFFSET page): the cursor is
// "<ISO timestamp>|<row id>" of the last row returned, re-applied
// per source as a (createdAt, id) bound, so rows sharing a
// millisecond are never skipped or repeated.
//
// Source rules (plan §3.1, confirmed in build):
// - AuditLog: every row. resourceType/outcome filters apply here.
// - SubscriptionEvent: every type (the subscription timeline).
// - BillingEvent: every kind (webhook history).
// - SubmissionEvent: admin-relevant types only — MARKED_SPAM,
//   EMAIL_SENT, EMAIL_FAILED, EMAIL_QUEUED. Inbox noise (CREATED,
//   READ/UNREAD, STARRED/UNSTARRED, ARCHIVED/RESTORED) stays in the
//   inbox; it is not platform activity.
//
// Filter mapping across sources: `resourceType` is an AuditResource
// value — SUBSCRIPTION also matches subscription events, SUBMISSION
// also matches submission events, BILLING_PROVIDER also matches
// billing events; every other value matches audit rows only.
// `outcome` exists only on audit rows, so setting it restricts the
// feed to audit rows. `q` is free text on the resource id (audit
// resourceId, subscription id, provider event id, submission id).

export type ActivitySource = "audit" | "subscription" | "billing" | "submission"

export type ActivityTab = "all" | "users" | "billing" | "ai" | "support"

export type ActivityFeedRow = {
  /** Globally unique across sources: "<source>:<row id>". */
  id: string
  source: ActivitySource
  at: Date
  actorId: string | null
  actorLabel: string
  kind: string
  title: string
  detailHref: string
}

export type ActivityFeedResponse = {
  rows: ActivityFeedRow[]
  /** Cursor for the next page, or null when the feed is exhausted. */
  nextCursor: string | null
}

// Submission lifecycle types that count as platform activity (see
// the module header). The rest are inbox noise.
export const ACTIVITY_SUBMISSION_TYPES: SubmissionEventType[] = [
  "MARKED_SPAM",
  "EMAIL_SENT",
  "EMAIL_FAILED",
  "EMAIL_QUEUED",
]

// Subscription types that are money movement, so they read as
// billing activity rather than user activity.
const BILLING_SUBSCRIPTION_TYPES: SubscriptionEventType[] = [
  "PAYMENT_FAILED",
  "REFUNDED",
]

/** The one tab a row belongs to. Every row is in "all"; each row is
    in exactly one of the other tabs. */
export function activityTabForRow(
  row: Pick<ActivityFeedRow, "source" | "kind">
): ActivityTab {
  if (row.source === "billing") return "billing"
  if (row.source === "submission") return "support"
  if (row.source === "subscription") {
    const type = row.kind.slice("subscription:".length)
    return (BILLING_SUBSCRIPTION_TYPES as string[]).includes(type)
      ? "billing"
      : "users"
  }
  const resource = row.kind.slice("audit:".length).split(":")[0]
  if (resource === "USER") return "users"
  if (resource === "SUPPORT_TICKET") return "support"
  if (resource === "AI_KEY") return "ai"
  return "all"
}

function actorLabel(
  actor: {
    name: string | null
    email: string
  } | null
): string {
  return actor?.name ?? actor?.email ?? "System"
}

type Cursor = { at: Date; id: string }

function parseCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null
  const sep = raw.lastIndexOf("|")
  if (sep <= 0) throw new ApiError("Invalid cursor.", 422)
  const at = new Date(raw.slice(0, sep))
  const id = raw.slice(sep + 1)
  if (Number.isNaN(at.getTime()) || id.length === 0) {
    throw new ApiError("Invalid cursor.", 422)
  }
  return { at, id }
}

function cursorWhere(cursor: Cursor | null): Prisma.AuditLogWhereInput | null {
  if (!cursor) return null
  // Rows strictly before (at, id) in (createdAt desc, id desc)
  // order — the same bound for every source, so the merge never
  // skips or repeats a row across pages.
  return {
    OR: [
      { createdAt: { lt: cursor.at } },
      { createdAt: cursor.at, id: { lt: cursor.id } },
    ],
  }
}

function dateWhere(filters: ActivityFeedQuery): {
  gte?: Date
  lte?: Date
} {
  const createdAt: { gte?: Date; lte?: Date } = {}
  if (filters.from) {
    const d = new Date(filters.from)
    if (!Number.isNaN(d.getTime())) createdAt.gte = d
  }
  if (filters.to) {
    const d = new Date(filters.to)
    if (!Number.isNaN(d.getTime())) createdAt.lte = d
  }
  return createdAt
}

function validateEnumFilters(filters: ActivityFeedQuery): void {
  if (
    filters.resourceType &&
    !(Object.values(AuditResource) as string[]).includes(filters.resourceType)
  ) {
    throw new ApiError(`Unknown audit resource: ${filters.resourceType}.`, 422)
  }
  if (
    filters.outcome &&
    !(Object.values(AuditOutcome) as string[]).includes(filters.outcome)
  ) {
    throw new ApiError(`Unknown audit outcome: ${filters.outcome}.`, 422)
  }
}

/** Unified feed, newest first. Reads need VIEW_AUDIT_LOGS — the
    same gate as /admin/audit-logs, so SUPPORT staff are refused
    here exactly as they are there. */
export async function listActivityFeed(
  actor: AdminSession,
  filters: ActivityFeedQuery
): Promise<ActivityFeedResponse> {
  requireAdmin(actor, "VIEW_AUDIT_LOGS")
  validateEnumFilters(filters)
  const cursor = parseCursor(filters.cursor)
  const limit = filters.limit
  const createdAt = dateWhere(filters)
  const cursorBound = cursorWhere(cursor)
  const and = <T>(where: T): T[] =>
    cursorBound ? [where, cursorBound as unknown as T] : [where]

  const auditWhere: Prisma.AuditLogWhereInput = {}
  if (filters.actorId) auditWhere.userId = filters.actorId
  if (filters.outcome) {
    auditWhere.outcome = filters.outcome as AuditOutcome
  }
  if (filters.q) {
    auditWhere.resourceId = { contains: filters.q, mode: "insensitive" }
  }
  if (Object.keys(createdAt).length > 0) auditWhere.createdAt = createdAt
  // The tab is pushed into each source query (not applied after the
  // merge): a tab filter applied after the per-source `take` could
  // end a page early with a null cursor while matching rows still
  // exist. Audit rows carry a tab only for USER / SUPPORT_TICKET /
  // AI_KEY; every other audit row is "all"-only. A tab and a
  // resourceType filter intersect: when they disagree no audit row
  // can match both, so the audit source is skipped outright.
  const tabResource: AuditResource | null =
    filters.tab === "users"
      ? "USER"
      : filters.tab === "support"
        ? "SUPPORT_TICKET"
        : filters.tab === "ai"
          ? "AI_KEY"
          : null
  const includeAudit =
    filters.tab !== "billing" &&
    (!tabResource ||
      !filters.resourceType ||
      filters.resourceType === tabResource)
  const auditResource = filters.resourceType ?? tabResource
  if (auditResource) {
    auditWhere.resourceType = auditResource as AuditResource
  }

  const subscriptionWhere: Prisma.SubscriptionEventWhereInput = {}
  if (filters.actorId) subscriptionWhere.adminId = filters.actorId
  if (filters.q) {
    subscriptionWhere.subscriptionId = {
      contains: filters.q,
      mode: "insensitive",
    }
  }
  if (Object.keys(createdAt).length > 0) {
    subscriptionWhere.createdAt = createdAt
  }
  // Subscription events split by tab: money-movement types read as
  // billing, the rest as user activity; the ai/support tabs carry no
  // subscription rows.
  if (filters.tab === "billing") {
    subscriptionWhere.type = { in: BILLING_SUBSCRIPTION_TYPES }
  } else if (filters.tab === "users") {
    subscriptionWhere.type = { notIn: BILLING_SUBSCRIPTION_TYPES }
  }

  const billingWhere: Prisma.BillingEventWhereInput = {}
  if (filters.actorId) billingWhere.userId = filters.actorId
  if (filters.q) {
    billingWhere.providerEventId = {
      contains: filters.q,
      mode: "insensitive",
    }
  }
  if (Object.keys(createdAt).length > 0) billingWhere.createdAt = createdAt

  const submissionWhere: Prisma.SubmissionEventWhereInput = {
    type: { in: ACTIVITY_SUBMISSION_TYPES },
  }
  if (filters.actorId) submissionWhere.actorId = filters.actorId
  if (filters.q) {
    submissionWhere.submissionId = {
      contains: filters.q,
      mode: "insensitive",
    }
  }
  if (Object.keys(createdAt).length > 0) {
    submissionWhere.createdAt = createdAt
  }

  // Which non-audit sources the resourceType filter admits. An
  // outcome filter admits none of them (only audit rows carry an
  // outcome); a resourceType outside the three mapped values admits
  // none either. The tab admits: subscription rows on all/users/
  // billing, billing rows on all/billing, submission rows on
  // all/support.
  const includeSubscription =
    !filters.outcome &&
    (!filters.resourceType || filters.resourceType === "SUBSCRIPTION") &&
    (filters.tab === "all" ||
      filters.tab === "users" ||
      filters.tab === "billing")
  const includeBilling =
    !filters.outcome &&
    (!filters.resourceType || filters.resourceType === "BILLING_PROVIDER") &&
    (filters.tab === "all" || filters.tab === "billing")
  const includeSubmission =
    !filters.outcome &&
    (!filters.resourceType || filters.resourceType === "SUBMISSION") &&
    (filters.tab === "all" || filters.tab === "support")

  const [auditRows, subscriptionRows, billingRows, submissionRows] =
    await Promise.all([
      includeAudit
        ? db.auditLog.findMany({
            where: { AND: and(auditWhere) },
            select: {
              id: true,
              action: true,
              resourceType: true,
              resourceId: true,
              outcome: true,
              createdAt: true,
              user: { select: { id: true, name: true, email: true } },
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit + 1,
          })
        : Promise.resolve([]),
      includeSubscription
        ? db.subscriptionEvent.findMany({
            where: { AND: and(subscriptionWhere) },
            select: {
              id: true,
              subscriptionId: true,
              type: true,
              createdAt: true,
              admin: { select: { id: true, name: true, email: true } },
              subscription: { select: { userId: true } },
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit + 1,
          })
        : Promise.resolve([]),
      includeBilling
        ? db.billingEvent.findMany({
            where: { AND: and(billingWhere) },
            select: {
              id: true,
              provider: true,
              providerEventId: true,
              eventType: true,
              kind: true,
              userId: true,
              createdAt: true,
              user: { select: { id: true, name: true, email: true } },
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit + 1,
          })
        : Promise.resolve([]),
      includeSubmission
        ? db.submissionEvent.findMany({
            where: { AND: and(submissionWhere) },
            select: {
              id: true,
              submissionId: true,
              type: true,
              createdAt: true,
              actor: { select: { id: true, name: true, email: true } },
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit + 1,
          })
        : Promise.resolve([]),
    ])

  const rows: ActivityFeedRow[] = [
    ...auditRows.map((row): ActivityFeedRow => ({
      id: `audit:${row.id}`,
      source: "audit",
      at: row.createdAt,
      actorId: row.user?.id ?? null,
      actorLabel: actorLabel(row.user),
      kind: `audit:${row.resourceType}:${row.action}`,
      title: `${row.action} ${row.resourceType}`,
      detailHref: "/admin/audit-logs",
    })),
    ...subscriptionRows.map((row): ActivityFeedRow => ({
      id: `subscription:${row.id}`,
      source: "subscription",
      at: row.createdAt,
      actorId: row.admin?.id ?? null,
      actorLabel: actorLabel(row.admin),
      kind: `subscription:${row.type}`,
      title: `Subscription ${row.type}`,
      detailHref: `/admin/all-users/${row.subscription.userId}`,
    })),
    ...billingRows.map((row): ActivityFeedRow => ({
      id: `billing:${row.id}`,
      source: "billing",
      at: row.createdAt,
      actorId: row.user?.id ?? null,
      actorLabel: actorLabel(row.user),
      kind: `billing:${row.kind ?? row.eventType}`,
      title: `Billing ${row.kind ?? row.eventType}`,
      detailHref: row.userId
        ? `/admin/all-users/${row.userId}`
        : "/admin/billing",
    })),
    ...submissionRows.map((row): ActivityFeedRow => ({
      id: `submission:${row.id}`,
      source: "submission",
      at: row.createdAt,
      actorId: row.actor?.id ?? null,
      actorLabel: actorLabel(row.actor),
      kind: `submission:${row.type}`,
      title: `Submission ${row.type}`,
      detailHref: "/admin/submissions",
    })),
  ]

  // True createdAt order across sources; id breaks ties so the
  // order is deterministic for rows sharing a millisecond.
  rows.sort((a, b) => {
    const byTime = b.at.getTime() - a.at.getTime()
    if (byTime !== 0) return byTime
    return b.id.localeCompare(a.id)
  })

  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    rows: page,
    nextCursor:
      rows.length > limit && last
        ? `${last.at.toISOString()}|${last.id.slice(last.id.indexOf(":") + 1)}`
        : null,
  }
}

// Re-exported for the filter tests: the billing-kind values the feed
// can carry (BillingEventKind is nullable on old rows — the title
// falls back to the raw provider eventType then).
export const ACTIVITY_BILLING_KINDS: BillingEventKind[] =
  Object.values(BillingEventKind)
export const ACTIVITY_SUBSCRIPTION_EVENT_TYPES: SubscriptionEventType[] =
  Object.values(SubscriptionEventType)
