import type { AdminSession } from "@sendcms/auth"
import {
  DomainStatus,
  Prisma,
  SubmissionStatus,
  SubscriptionStatus,
  UserStatus,
  db,
} from "@sendcms/database"
import { requireAdmin } from "./require-admin"
import type { OverviewQuery, OverviewRangeKey } from "./validators"

// Admin overview (Admin Control Plane, Phase 9, spec §3). Real
// aggregations for a date range — no hardcoded numbers, no fake stats.
// Framework-independent (no Next.js imports); only services import
// @sendcms/database. Reads need VIEW_ADMIN_DASHBOARD.
//
// The per-day series is aggregated in SQL (DATE_TRUNC + GROUP BY) —
// the old shape loaded every submission timestamp in range into
// memory (SRC-236). Status breakdowns always list every status
// (missing ones are 0), so the client renders a stable shape.

export type DayCount = { date: string; count: number }

export type AdminOverview = {
  range: { key: OverviewRangeKey; from: string; to: string }
  users: {
    total: number
    newInRange: number
    byStatus: { status: UserStatus; count: number }[]
  }
  submissions: {
    total: number
    inRange: number
    byStatus: { status: SubmissionStatus; count: number }[]
    perDay: DayCount[]
  }
  forms: { total: number; active: number }
  domains: { total: number; verified: number }
  subscriptions: {
    active: number
    byPlan: { planId: string; planName: string; count: number }[]
  }
  ai: { callsInRange: number }
  mcp: { callsInRange: number }
}

const RANGE_MS: Record<Exclude<OverviewRangeKey, "custom">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
  "12mo": 365 * 24 * 60 * 60 * 1000,
}

const ALL_USER_STATUSES: UserStatus[] = [
  UserStatus.ACTIVE,
  UserStatus.SUSPENDED,
  UserStatus.DISABLED,
]

const ALL_SUBMISSION_STATUSES: SubmissionStatus[] = [
  SubmissionStatus.NEW,
  SubmissionStatus.READ,
  SubmissionStatus.STARRED,
  SubmissionStatus.ARCHIVED,
  SubmissionStatus.SPAM,
]

/** Resolve the effective [from, to] window for a range query. Presets
    end at `now`; a custom `to` in the future is clamped to `now` (the
    returned window is the effective one, so the client shows what the
    numbers actually cover). */
export function resolveOverviewRange(
  query: OverviewQuery,
  now = new Date()
): { key: OverviewRangeKey; from: Date; to: Date } {
  if (query.range === "custom") {
    const from = new Date(query.from as string)
    const to = new Date(query.to as string)
    return { key: "custom", from, to: to > now ? now : to }
  }
  return {
    key: query.range,
    from: new Date(now.getTime() - RANGE_MS[query.range]),
    to: now,
  }
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Pure: bucket timestamps into per-day counts from the UTC day of
    `from` through the UTC day of `to`. Days with no submissions get
    count 0. */
export function bucketOverviewByDay(
  dates: Date[],
  from: Date,
  to: Date
): DayCount[] {
  const counts = new Map<string, number>()
  for (const date of dates) {
    const key = dayKey(date)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return expandDayCounts(counts, from, to)
}

/** Pure: expand a day → count map into the full per-day series from
    the UTC day of `from` through the UTC day of `to`. Days absent
    from the map get count 0. The SQL-aggregated series feeds this
    directly (one row per day that has submissions); the timestamp
    bucketing above is the same expansion over a counted map. */
export function expandDayCounts(
  counts: Map<string, number>,
  from: Date,
  to: Date
): DayCount[] {
  const start = new Date(from)
  start.setUTCHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setUTCHours(0, 0, 0, 0)
  const out: DayCount[] = []
  for (
    let day = new Date(start);
    day <= end;
    day.setUTCDate(day.getUTCDate() + 1)
  ) {
    const key = dayKey(day)
    out.push({ date: key, count: counts.get(key) ?? 0 })
  }
  return out
}

/** Platform overview for a date range: user totals + new users +
    status split, submission totals + in-range status split + per-day
    series, form/domain totals, active subscriptions by plan, and the
    AI + MCP call counts in range. Reads need VIEW_ADMIN_DASHBOARD. */
export async function getAdminOverview(
  actor: AdminSession,
  query: OverviewQuery
): Promise<AdminOverview> {
  requireAdmin(actor, "VIEW_ADMIN_DASHBOARD")
  const range = resolveOverviewRange(query)
  const { from, to } = range
  const inRange = { createdAt: { gte: from, lte: to } }

  const [
    userTotal,
    usersNew,
    usersByStatusRaw,
    submissionTotal,
    submissionsInRange,
    submissionsByStatusRaw,
    perDayRows,
    formTotal,
    formsActive,
    domainTotal,
    domainsVerified,
    activeSubscriptions,
    subsByPlanRaw,
    aiCalls,
    mcpCalls,
  ] = await Promise.all([
    db.user.count(),
    db.user.count({ where: inRange }),
    db.user.groupBy({ by: ["status"], _count: true }),
    db.submission.count(),
    db.submission.count({ where: inRange }),
    db.submission.groupBy({ by: ["status"], where: inRange, _count: true }),
    // SRC-236: the per-day series is aggregated in SQL (one row per
    // day that has submissions) instead of loading every in-range
    // timestamp into memory. The day is rendered as a YYYY-MM-DD
    // string in UTC, so no session-timezone skew can move a
    // submission onto the wrong day; COUNT(*)::int keeps the count
    // a JS number, not a bigint.
    db.$queryRaw<{ day: string; count: number }[]>(Prisma.sql`
      SELECT TO_CHAR(
          DATE_TRUNC('day', "createdAt" AT TIME ZONE 'UTC'),
          'YYYY-MM-DD'
        ) AS day,
        COUNT(*)::int AS count
      FROM "Submission"
      WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
      GROUP BY 1
      ORDER BY 1
    `),
    db.form.count(),
    db.form.count({ where: { active: true } }),
    db.domain.count(),
    db.domain.count({ where: { status: DomainStatus.VERIFIED } }),
    db.subscription.count({ where: { status: SubscriptionStatus.ACTIVE } }),
    db.subscription.groupBy({
      by: ["planId"],
      where: { status: SubscriptionStatus.ACTIVE },
      _count: true,
      orderBy: { _count: { planId: "desc" } },
    }),
    db.aiUsageRecord.count({ where: inRange }),
    db.mcpUsageRecord.count({ where: inRange }),
  ])

  // Plan names for the by-plan split (same shape as the analytics
  // module's form-name lookup). A plan cannot be deleted while a
  // subscription points at it (Restrict), so the name always resolves;
  // the id is the fallback anyway.
  const planNames = new Map(
    (
      await db.plan.findMany({
        where: { id: { in: subsByPlanRaw.map((row) => row.planId) } },
        select: { id: true, name: true },
      })
    ).map((plan) => [plan.id, plan.name])
  )

  const usersByStatusMap = new Map(
    usersByStatusRaw.map((row) => [row.status, row._count])
  )
  const submissionsByStatusMap = new Map(
    submissionsByStatusRaw.map((row) => [row.status, row._count])
  )

  return {
    range: {
      key: range.key,
      from: from.toISOString(),
      to: to.toISOString(),
    },
    users: {
      total: userTotal,
      newInRange: usersNew,
      byStatus: ALL_USER_STATUSES.map((status) => ({
        status,
        count: usersByStatusMap.get(status) ?? 0,
      })),
    },
    submissions: {
      total: submissionTotal,
      inRange: submissionsInRange,
      byStatus: ALL_SUBMISSION_STATUSES.map((status) => ({
        status,
        count: submissionsByStatusMap.get(status) ?? 0,
      })),
      perDay: expandDayCounts(
        new Map(perDayRows.map((row) => [row.day, row.count])),
        from,
        to
      ),
    },
    forms: { total: formTotal, active: formsActive },
    domains: { total: domainTotal, verified: domainsVerified },
    subscriptions: {
      active: activeSubscriptions,
      byPlan: subsByPlanRaw.map((row) => ({
        planId: row.planId,
        planName: planNames.get(row.planId) ?? row.planId,
        count: row._count,
      })),
    },
    ai: { callsInRange: aiCalls },
    mcp: { callsInRange: mcpCalls },
  }
}
