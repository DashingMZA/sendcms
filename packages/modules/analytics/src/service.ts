import { SubmissionStatus, db } from "@sendcms/database"

import { getSubmissionSender, previewSubmissionText } from "@sendcms/shared"

export type DayCount = { date: string; count: number }

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Pure: bucket timestamps into per-day counts for the last `days`
    days (UTC, ending today). Days with no submissions get count 0. */
export function bucketByDay(
  dates: Date[],
  days: number,
  now = new Date()
): DayCount[] {
  const counts = new Map<string, number>()
  for (const date of dates) {
    const key = dayKey(date)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const out: DayCount[] = []
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now)
    day.setUTCDate(now.getUTCDate() - i)
    const key = dayKey(day)
    out.push({ date: key, count: counts.get(key) ?? 0 })
  }
  return out
}

export type RecentSubmission = {
  id: string
  formId: string
  formName: string
  senderName: string | null
  senderEmail: string | null
  preview: string
  status: SubmissionStatus
  createdAt: Date
}

export type DashboardOverview = {
  domainCount: number
  verifiedDomainCount: number
  formCount: number
  activeFormCount: number
  submissionCount: number
  unreadCount: number
  spamCount: number
  // DSH-004: READ / STARRED / ARCHIVED counted separately — the old
  // overview derived "read" as total − NEW − SPAM, which lumped
  // STARRED and ARCHIVED under "read".
  readCount: number
  starredCount: number
  archivedCount: number
  recentSubmissions: RecentSubmission[]
  activity: DayCount[]
}

/** Overview stats for one user. Every submission query filters on
    the denormalized `ownerId` (PRF-011, Phase 16, Wave 3) — served by
    @@index([ownerId, status, createdAt]) / @@index([ownerId,
    createdAt]) — instead of joining Form. The `recent` query still
    includes the form, but only to read its name for display. */
export async function getDashboardOverview(
  userId: string
): Promise<DashboardOverview> {
  const [
    domainCount,
    verifiedDomainCount,
    formCount,
    activeFormCount,
    submissionCount,
    unreadCount,
    spamCount,
    readCount,
    starredCount,
    archivedCount,
    recent,
    recentDates,
  ] = await Promise.all([
    db.domain.count({ where: { ownerId: userId } }),
    db.domain.count({
      where: { ownerId: userId, status: "VERIFIED" },
    }),
    db.form.count({ where: { ownerId: userId } }),
    db.form.count({ where: { ownerId: userId, active: true } }),
    db.submission.count({ where: { ownerId: userId } }),
    db.submission.count({
      where: { ownerId: userId, status: SubmissionStatus.NEW },
    }),
    db.submission.count({
      where: { ownerId: userId, status: SubmissionStatus.SPAM },
    }),
    db.submission.count({
      where: { ownerId: userId, status: SubmissionStatus.READ },
    }),
    db.submission.count({
      where: { ownerId: userId, status: SubmissionStatus.STARRED },
    }),
    db.submission.count({
      where: { ownerId: userId, status: SubmissionStatus.ARCHIVED },
    }),
    db.submission.findMany({
      where: { ownerId: userId },
      include: { form: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    db.submission.findMany({
      where: {
        ownerId: userId,
        createdAt: {
          gte: new Date(Date.now() - 13 * 24 * 60 * 60 * 1000),
        },
      },
      select: { createdAt: true },
    }),
  ])

  return {
    domainCount,
    verifiedDomainCount,
    formCount,
    activeFormCount,
    submissionCount,
    unreadCount,
    spamCount,
    readCount,
    starredCount,
    archivedCount,
    recentSubmissions: recent.map((submission) => {
      const sender = getSubmissionSender(submission.data)
      return {
        id: submission.id,
        formId: submission.formId,
        formName: submission.form.name,
        senderName: sender.name,
        senderEmail: sender.email,
        preview: previewSubmissionText(submission.data),
        status: submission.status,
        createdAt: submission.createdAt,
      }
    }),
    activity: bucketByDay(
      recentDates.map((row) => row.createdAt),
      14
    ),
  }
}

export type SubmissionAnalytics = {
  total: number
  byDay: DayCount[]
  byForm: { formId: string; formName: string; count: number }[]
  byDomain: { domain: string; count: number }[]
  byStatus: { status: SubmissionStatus; count: number }[]
}

export async function getSubmissionAnalytics(
  userId: string,
  days = 30
): Promise<SubmissionAnalytics> {
  // SRC-236: clamp `days` to 1–365 at the service — a negative value
  // used to yield an empty result and a huge one loaded the whole
  // table (the unbounded findMany below). Callers happen to be safe
  // (dashboard hardcodes 30; MCP zod-validates 1–365); this is the
  // defense-in-depth half.
  const clampedDays = Number.isFinite(days)
    ? Math.min(365, Math.max(1, Math.floor(days)))
    : 30
  // DSH-407: align `since` to UTC start of day (clampedDays - 1) days
  // ago. The old rolling instant (now − 29d) excluded the early hours
  // of the first calendar day that `bucketByDay`'s first bucket
  // covers, so the headline total disagreed with the chart. With the
  // start-of-day bound, total == sum(byDay).
  const since = new Date(Date.now() - (clampedDays - 1) * 24 * 60 * 60 * 1000)
  since.setUTCHours(0, 0, 0, 0)
  const [total, rows, byFormRaw, byDomainRaw, byStatusRaw] = await Promise.all([
    db.submission.count({
      where: { ownerId: userId, createdAt: { gte: since } },
    }),
    db.submission.findMany({
      where: { ownerId: userId, createdAt: { gte: since } },
      select: { createdAt: true },
    }),
    db.submission.groupBy({
      by: ["formId"],
      where: { ownerId: userId, createdAt: { gte: since } },
      _count: true,
      orderBy: { _count: { formId: "desc" } },
    }),
    db.submission.groupBy({
      by: ["originDomain"],
      where: { ownerId: userId, createdAt: { gte: since } },
      _count: true,
      orderBy: { _count: { originDomain: "desc" } },
    }),
    db.submission.groupBy({
      by: ["status"],
      where: { ownerId: userId, createdAt: { gte: since } },
      _count: true,
    }),
  ])

  const formNames = new Map(
    (
      await db.form.findMany({
        where: {
          ownerId: userId,
          id: { in: byFormRaw.map((row) => row.formId) },
        },
        select: { id: true, name: true },
      })
    ).map((form) => [form.id, form.name])
  )

  return {
    total,
    byDay: bucketByDay(
      rows.map((row) => row.createdAt),
      clampedDays
    ),
    byForm: byFormRaw.map((row) => ({
      formId: row.formId,
      formName: formNames.get(row.formId) ?? "Deleted form",
      count: row._count,
    })),
    byDomain: byDomainRaw.map((row) => ({
      domain: row.originDomain,
      count: row._count,
    })),
    byStatus: byStatusRaw.map((row) => ({
      status: row.status,
      count: row._count,
    })),
  }
}
