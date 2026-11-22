// Admin overview (Phase 9, spec §3) with a mocked Prisma client.
// These pin the aggregation decisions — totals, the in-range status
// splits, the per-day bucketing, and the by-plan name lookup. No test
// hits the real DB.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AdminSession } from "@sendcms/auth"
import {
  bucketOverviewByDay,
  getAdminOverview,
  resolveOverviewRange,
} from "@sendcms/platform-ops"
import { OverviewQuerySchema } from "@sendcms/platform-ops/validators"

function makeSession(
  overrides: Partial<AdminSession["user"]> = {}
): AdminSession {
  return {
    user: {
      id: "admin-1",
      name: "Admin",
      email: "admin@csofts.com",
      image: null,
      platformRole: "PLATFORM_OWNER",
      status: "ACTIVE",
      adminRole: null,
      emailVerified: true,
      ...overrides,
    },
    session: { id: "sess-1", userId: "admin-1", expiresAt: new Date() },
  }
}

const ownerSession = makeSession()
const plainSession = makeSession({
  id: "user-9",
  email: "plain@example.com",
  platformRole: "PLATFORM_USER",
  adminRole: null,
})

const mockDb = vi.hoisted(() => ({
  user: { count: vi.fn(), groupBy: vi.fn() },
  submission: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
  form: { count: vi.fn() },
  domain: { count: vi.fn() },
  subscription: { count: vi.fn(), groupBy: vi.fn() },
  plan: { findMany: vi.fn() },
  aiUsageRecord: { count: vi.fn() },
  mcpUsageRecord: { count: vi.fn() },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

const NOW = new Date("2026-11-22T12:00:00.000Z")

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  mockDb.user.count.mockResolvedValue(10)
  mockDb.user.groupBy.mockResolvedValue([
    { status: "ACTIVE", _count: 8 },
    { status: "SUSPENDED", _count: 2 },
  ])
  mockDb.submission.count.mockResolvedValue(50)
  mockDb.submission.groupBy.mockResolvedValue([
    { status: "NEW", _count: 5 },
    { status: "SPAM", _count: 3 },
  ])
  mockDb.submission.findMany.mockResolvedValue([
    { createdAt: new Date("2026-11-22T09:00:00.000Z") },
    { createdAt: new Date("2026-11-22T10:00:00.000Z") },
    { createdAt: new Date("2026-11-20T08:00:00.000Z") },
  ])
  mockDb.form.count.mockResolvedValue(4)
  mockDb.domain.count.mockResolvedValue(6)
  mockDb.subscription.count.mockResolvedValue(3)
  mockDb.subscription.groupBy.mockResolvedValue([
    { planId: "plan-pro", _count: 2 },
    { planId: "plan-free", _count: 1 },
  ])
  mockDb.plan.findMany.mockResolvedValue([
    { id: "plan-pro", name: "Pro" },
    { id: "plan-free", name: "Free" },
  ])
  mockDb.aiUsageRecord.count.mockResolvedValue(12)
  mockDb.mcpUsageRecord.count.mockResolvedValue(34)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("OverviewQuerySchema", () => {
  it("defaults to the 7d range", () => {
    expect(OverviewQuerySchema.parse({})).toEqual({ range: "7d" })
  })

  it("accepts every preset range", () => {
    for (const range of ["24h", "7d", "30d", "90d", "12mo"]) {
      expect(OverviewQuerySchema.parse({ range }).range).toBe(range)
    }
  })

  it("rejects an unknown range", () => {
    expect(OverviewQuerySchema.safeParse({ range: "13mo" }).success).toBe(false)
  })

  it("accepts a valid custom range", () => {
    const parsed = OverviewQuerySchema.parse({
      range: "custom",
      from: "2026-11-01",
      to: "2026-11-15",
    })
    expect(parsed.from).toBe("2026-11-01")
    expect(parsed.to).toBe("2026-11-15")
  })

  it("rejects a custom range without from/to", () => {
    expect(OverviewQuerySchema.safeParse({ range: "custom" }).success).toBe(
      false
    )
    expect(
      OverviewQuerySchema.safeParse({ range: "custom", from: "2026-11-01" })
        .success
    ).toBe(false)
  })

  it("rejects a custom range where to is not after from", () => {
    expect(
      OverviewQuerySchema.safeParse({
        range: "custom",
        from: "2026-11-15",
        to: "2026-11-01",
      }).success
    ).toBe(false)
  })

  it("rejects a custom range over 366 days", () => {
    expect(
      OverviewQuerySchema.safeParse({
        range: "custom",
        from: "2025-01-01",
        to: "2026-11-22",
      }).success
    ).toBe(false)
  })
})

describe("resolveOverviewRange", () => {
  it("resolves 24h to the last 24 hours", () => {
    const range = resolveOverviewRange({ range: "24h" }, NOW)
    expect(range.from).toEqual(new Date(NOW.getTime() - 24 * 60 * 60 * 1000))
    expect(range.to).toEqual(NOW)
  })

  it("resolves 12mo to the last 365 days", () => {
    const range = resolveOverviewRange({ range: "12mo" }, NOW)
    expect(range.from).toEqual(
      new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000)
    )
    expect(range.to).toEqual(NOW)
  })

  it("clamps a custom to in the future to now", () => {
    const range = resolveOverviewRange(
      { range: "custom", from: "2026-11-01", to: "2027-01-01" },
      NOW
    )
    expect(range.to).toEqual(NOW)
    expect(range.from).toEqual(new Date("2026-11-01T00:00:00.000Z"))
  })
})

describe("bucketOverviewByDay", () => {
  it("buckets timestamps into per-day counts with zeros for gaps", () => {
    const out = bucketOverviewByDay(
      [
        new Date("2026-11-20T08:00:00.000Z"),
        new Date("2026-11-22T09:00:00.000Z"),
        new Date("2026-11-22T10:00:00.000Z"),
      ],
      new Date("2026-11-20T00:00:00.000Z"),
      new Date("2026-11-22T12:00:00.000Z")
    )
    expect(out).toEqual([
      { date: "2026-11-20", count: 1 },
      { date: "2026-11-21", count: 0 },
      { date: "2026-11-22", count: 2 },
    ])
  })

  it("returns all zeros when there are no dates", () => {
    const out = bucketOverviewByDay(
      [],
      new Date("2026-11-21T00:00:00.000Z"),
      new Date("2026-11-22T12:00:00.000Z")
    )
    expect(out).toEqual([
      { date: "2026-11-21", count: 0 },
      { date: "2026-11-22", count: 0 },
    ])
  })
})

describe("getAdminOverview", () => {
  it("aggregates totals, splits, series and plan names for the range", async () => {
    const overview = await getAdminOverview(ownerSession, { range: "7d" })

    expect(overview.range.key).toBe("7d")
    expect(overview.range.from).toBe(
      new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
    )
    expect(overview.range.to).toBe(NOW.toISOString())
    expect(overview.users.total).toBe(10)
    expect(overview.users.newInRange).toBe(10)
    expect(overview.submissions.total).toBe(50)
    expect(overview.submissions.inRange).toBe(50)
    expect(overview.forms).toEqual({ total: 4, active: 4 })
    expect(overview.domains).toEqual({ total: 6, verified: 6 })
    expect(overview.subscriptions.active).toBe(3)
    expect(overview.subscriptions.byPlan).toEqual([
      { planId: "plan-pro", planName: "Pro", count: 2 },
      { planId: "plan-free", planName: "Free", count: 1 },
    ])
    expect(overview.ai.callsInRange).toBe(12)
    expect(overview.mcp.callsInRange).toBe(34)
  })

  it("lists every status with 0 for the missing ones", async () => {
    const overview = await getAdminOverview(ownerSession, { range: "7d" })
    expect(overview.users.byStatus).toEqual([
      { status: "ACTIVE", count: 8 },
      { status: "SUSPENDED", count: 2 },
      { status: "DISABLED", count: 0 },
    ])
    expect(overview.submissions.byStatus).toEqual([
      { status: "NEW", count: 5 },
      { status: "READ", count: 0 },
      { status: "STARRED", count: 0 },
      { status: "ARCHIVED", count: 0 },
      { status: "SPAM", count: 3 },
    ])
  })

  it("buckets the in-range submissions per day", async () => {
    const overview = await getAdminOverview(ownerSession, { range: "7d" })
    expect(overview.submissions.perDay).toEqual([
      { date: "2026-11-15", count: 0 },
      { date: "2026-11-16", count: 0 },
      { date: "2026-11-17", count: 0 },
      { date: "2026-11-18", count: 0 },
      { date: "2026-11-19", count: 0 },
      { date: "2026-11-20", count: 1 },
      { date: "2026-11-21", count: 0 },
      { date: "2026-11-22", count: 2 },
    ])
    expect(mockDb.submission.findMany).toHaveBeenCalledWith({
      where: {
        createdAt: {
          gte: new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000),
          lte: NOW,
        },
      },
      select: { createdAt: true },
    })
  })

  it("scopes the in-range counts to the window", async () => {
    await getAdminOverview(ownerSession, { range: "24h" })
    const window = {
      gte: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      lte: NOW,
    }
    expect(mockDb.user.count).toHaveBeenCalledWith({
      where: { createdAt: window },
    })
    expect(mockDb.submission.count).toHaveBeenCalledWith({
      where: { createdAt: window },
    })
    expect(mockDb.aiUsageRecord.count).toHaveBeenCalledWith({
      where: { createdAt: window },
    })
    expect(mockDb.mcpUsageRecord.count).toHaveBeenCalledWith({
      where: { createdAt: window },
    })
  })

  it("refuses a plain user (403)", async () => {
    await expect(
      getAdminOverview(plainSession, { range: "7d" })
    ).rejects.toMatchObject({ status: 403 })
    expect(mockDb.user.count).not.toHaveBeenCalled()
  })
})
