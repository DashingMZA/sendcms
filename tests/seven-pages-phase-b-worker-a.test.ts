// Phase B Worker A — Activity page (plan §3.1, Q2 = UNIFIED FEED).
//
// listActivityFeed merge/ordering/filter/cursor behaviour with a
// mocked Prisma client (no test hits the real DB), the thin activity
// route gate, plus static regression tests guarding the wiring
// (page, feed component, route shape, i18n keys, loading/error
// boundaries). The capability map + sidebar + packages/i18n loader
// registration are coordinator-owned and intentionally NOT asserted
// here — see the worker report for the exact edits.
//
// Time note: every time assertion here compares ISO strings
// (toISOString, UTC) or Date getTime values — no test asserts a
// rendered clock time, so no timeZone pin is needed.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  auditLog: { findMany: vi.fn() },
  subscriptionEvent: { findMany: vi.fn() },
  billingEvent: { findMany: vi.fn() },
  submissionEvent: { findMany: vi.fn() },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

// Route gate mocks (only the route's auth/rate-limit helpers are
// mocked — the route calls the REAL listActivityFeed against the
// mocked db above).
const mockSession = { user: { id: "owner-1", platformRole: "PLATFORM_OWNER" } }
const mockRequireAdminApi = vi.hoisted(() => vi.fn(async () => mockSession))
const mockEnforceRateLimit = vi.hoisted(() =>
  vi.fn(async (): Promise<import("next/server").NextResponse | null> => null)
)
vi.mock("@/lib/require-admin-api", () => ({
  requireAdminApi: mockRequireAdminApi,
}))
vi.mock("@/lib/rate-limit", () => ({
  enforceAdminApiRateLimit: mockEnforceRateLimit,
}))

import { NextRequest, NextResponse } from "next/server"
import { ApiError } from "@sendcms/api-client"
import { GET } from "../apps/api/app/api/v1/admin/activity/route"

import type { AdminSession } from "@sendcms/auth"
import {
  ACTIVITY_SUBMISSION_TYPES,
  activityTabForRow,
  listActivityFeed,
  type ActivityFeedQuery,
} from "@sendcms/platform-ops"

const root = process.cwd()
const read = (rel: string) => readFileSync(path.join(root, rel), "utf-8")
const readJson = (rel: string): Record<string, string> =>
  JSON.parse(read(rel)) as Record<string, string>

function makeActor(
  overrides: Partial<AdminSession["user"]> = {}
): AdminSession {
  return {
    user: {
      id: "admin-1",
      name: "Admin",
      email: "admin@example.com",
      image: null,
      platformRole: "PLATFORM_USER",
      status: "ACTIVE",
      adminRole: null,
      emailVerified: true,
      ...overrides,
    },
    session: {
      id: "sess-1",
      userId: "admin-1",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    },
  }
}

const ownerActor = () =>
  makeActor({ id: "owner-1", platformRole: "PLATFORM_OWNER" })
const plainUserActor = () => makeActor()
const supportActor = () => makeActor({ id: "support-1", adminRole: "SUPPORT" })
const managerActor = () => makeActor({ id: "manager-1", adminRole: "MANAGER" })

const actor = (id: string) => ({
  id,
  name: `Admin ${id}`,
  email: `${id}@example.com`,
})

function auditRow(
  id: string,
  at: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    action: "UPDATE",
    resourceType: "USER",
    resourceId: `user-${id}`,
    outcome: "SUCCESS",
    createdAt: new Date(at),
    user: actor("admin-1"),
    ...overrides,
  }
}

function subscriptionRow(id: string, at: string, type = "RENEWED") {
  return {
    id,
    subscriptionId: `sub-${id}`,
    type,
    createdAt: new Date(at),
    admin: actor("admin-1"),
    subscription: { userId: "user-1" },
  }
}

function billingRow(id: string, at: string, kind = "PAYMENT_SUCCEEDED") {
  return {
    id,
    provider: "STRIPE",
    providerEventId: `evt_${id}`,
    eventType: "payment_intent.succeeded",
    kind,
    userId: "user-1",
    createdAt: new Date(at),
    user: actor("user-1"),
  }
}

function submissionRow(id: string, at: string, type = "MARKED_SPAM") {
  return {
    id,
    submissionId: `subm-${id}`,
    type,
    createdAt: new Date(at),
    actor: actor("admin-1"),
  }
}

const baseFilters = (
  overrides: Partial<ActivityFeedQuery> = {}
): ActivityFeedQuery => ({
  limit: 20,
  tab: "all",
  ...overrides,
})

// The mock findMany applies the service's cursor bound + take to a
// fixed dataset, so cursor pagination runs end-to-end through the
// real service. Other filters are asserted from the captured args,
// not simulated here.
type RowWithAt = { id: string; createdAt: Date; type?: string }

function cursorPaged(rows: RowWithAt[]) {
  return async (args: {
    where?: { AND?: Record<string, unknown>[] }
    take?: number
  }) => {
    let out = [...rows]
    const and = args?.where?.AND ?? []
    for (const clause of and) {
      const or = (clause as { OR?: { createdAt?: unknown }[] }).OR
      if (or) {
        const lt = (or[0] as { createdAt?: { lt?: Date } }).createdAt?.lt
        const eq = or[1] as { createdAt?: Date; id?: { lt?: string } }
        out = out.filter((row) => {
          if (lt && row.createdAt < lt) return true
          if (
            eq?.createdAt &&
            row.createdAt.getTime() === eq.createdAt.getTime() &&
            eq.id?.lt !== undefined &&
            row.id < eq.id.lt
          ) {
            return true
          }
          return false
        })
      }
      const typeIn = (clause as { type?: { in?: string[] } }).type?.in
      if (typeIn) {
        out = out.filter((row) => row.type && typeIn.includes(row.type))
      }
    }
    out.sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b.id.localeCompare(a.id)
    )
    return out.slice(0, args?.take ?? out.length)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("listActivityFeed — ordering across mixed sources", () => {
  it("interleaves audit + subscription + billing + submission rows in true createdAt order", async () => {
    mockDb.auditLog.findMany.mockResolvedValue([
      auditRow("a1", "2026-11-26T10:00:00.000Z"),
      auditRow("a2", "2026-11-26T08:00:00.000Z"),
    ])
    mockDb.subscriptionEvent.findMany.mockResolvedValue([
      subscriptionRow("s1", "2026-11-26T09:30:00.000Z"),
    ])
    mockDb.billingEvent.findMany.mockResolvedValue([
      billingRow("b1", "2026-11-26T09:00:00.000Z"),
    ])
    mockDb.submissionEvent.findMany.mockResolvedValue([
      submissionRow("e1", "2026-11-26T11:00:00.000Z"),
    ])
    const feed = await listActivityFeed(ownerActor(), baseFilters())
    expect(feed.rows.map((row) => row.id)).toEqual([
      "submission:e1",
      "audit:a1",
      "subscription:s1",
      "billing:b1",
      "audit:a2",
    ])
    expect(feed.nextCursor).toBeNull()
    // Common row shape, per plan §3.1.
    const first = feed.rows[0]
    expect(first.source).toBe("submission")
    expect(first.at.toISOString()).toBe("2026-11-26T11:00:00.000Z")
    expect(first.actorId).toBe("admin-1")
    expect(first.actorLabel).toBe("Admin admin-1")
    expect(first.kind).toBe("submission:MARKED_SPAM")
    expect(first.title).toBe("Submission MARKED_SPAM")
    expect(first.detailHref).toBe("/admin/submissions")
  })

  it("links each row to its source record", async () => {
    mockDb.auditLog.findMany.mockResolvedValue([
      auditRow("a1", "2026-11-26T10:00:00.000Z"),
    ])
    mockDb.subscriptionEvent.findMany.mockResolvedValue([
      subscriptionRow("s1", "2026-11-26T09:30:00.000Z"),
    ])
    mockDb.billingEvent.findMany.mockResolvedValue([
      billingRow("b1", "2026-11-26T09:00:00.000Z"),
    ])
    mockDb.submissionEvent.findMany.mockResolvedValue([])
    const feed = await listActivityFeed(ownerActor(), baseFilters())
    const byId = Object.fromEntries(feed.rows.map((row) => [row.id, row]))
    expect(byId["audit:a1"].detailHref).toBe("/admin/audit-logs")
    expect(byId["subscription:s1"].detailHref).toBe("/admin/all-users/user-1")
    expect(byId["billing:b1"].detailHref).toBe("/admin/all-users/user-1")
  })

  it("labels a system actor (null user) as System", async () => {
    mockDb.auditLog.findMany.mockResolvedValue([
      auditRow("a1", "2026-11-26T10:00:00.000Z", { user: null }),
    ])
    mockDb.subscriptionEvent.findMany.mockResolvedValue([])
    mockDb.billingEvent.findMany.mockResolvedValue([])
    mockDb.submissionEvent.findMany.mockResolvedValue([])
    const feed = await listActivityFeed(ownerActor(), baseFilters())
    expect(feed.rows[0].actorId).toBeNull()
    expect(feed.rows[0].actorLabel).toBe("System")
  })
})

describe("listActivityFeed — cursor pagination", () => {
  it("pages with a cursor and never skips or repeats a row", async () => {
    const audits = [
      auditRow("a1", "2026-11-26T10:00:00.000Z"),
      auditRow("a2", "2026-11-26T09:00:00.000Z"),
    ]
    const subs = [subscriptionRow("s1", "2026-11-26T09:30:00.000Z")]
    const billings = [billingRow("b1", "2026-11-26T08:00:00.000Z")]
    mockDb.auditLog.findMany.mockImplementation(cursorPaged(audits))
    mockDb.subscriptionEvent.findMany.mockImplementation(cursorPaged(subs))
    mockDb.billingEvent.findMany.mockImplementation(cursorPaged(billings))
    mockDb.submissionEvent.findMany.mockImplementation(cursorPaged([]))

    const page1 = await listActivityFeed(
      ownerActor(),
      baseFilters({ limit: 2 })
    )
    expect(page1.rows.map((row) => row.id)).toEqual([
      "audit:a1",
      "subscription:s1",
    ])
    expect(page1.nextCursor).toBe("2026-11-26T09:30:00.000Z|s1")

    const page2 = await listActivityFeed(
      ownerActor(),
      baseFilters({ limit: 2, cursor: page1.nextCursor ?? undefined })
    )
    expect(page2.rows.map((row) => row.id)).toEqual(["audit:a2", "billing:b1"])
    expect(page2.nextCursor).toBeNull()
  })

  it("keeps rows sharing a millisecond on the right side of the cursor", async () => {
    const audits = [
      auditRow("a1", "2026-11-26T10:00:00.000Z"),
      auditRow("a2", "2026-11-26T10:00:00.000Z"),
    ]
    mockDb.auditLog.findMany.mockImplementation(cursorPaged(audits))
    mockDb.subscriptionEvent.findMany.mockResolvedValue([])
    mockDb.billingEvent.findMany.mockResolvedValue([])
    mockDb.submissionEvent.findMany.mockResolvedValue([])

    const page1 = await listActivityFeed(
      ownerActor(),
      baseFilters({ limit: 1 })
    )
    expect(page1.rows.map((row) => row.id)).toEqual(["audit:a2"])
    expect(page1.nextCursor).toBe("2026-11-26T10:00:00.000Z|a2")
    const page2 = await listActivityFeed(
      ownerActor(),
      baseFilters({ limit: 1, cursor: page1.nextCursor ?? undefined })
    )
    expect(page2.rows.map((row) => row.id)).toEqual(["audit:a1"])
    expect(page2.nextCursor).toBeNull()
  })

  it("rejects a malformed cursor with 422", async () => {
    await expect(
      listActivityFeed(ownerActor(), baseFilters({ cursor: "not-a-cursor" }))
    ).rejects.toMatchObject({ status: 422 })
    expect(mockDb.auditLog.findMany).not.toHaveBeenCalled()
  })
})

describe("listActivityFeed — filters", () => {
  function emptyMocks() {
    mockDb.auditLog.findMany.mockResolvedValue([])
    mockDb.subscriptionEvent.findMany.mockResolvedValue([])
    mockDb.billingEvent.findMany.mockResolvedValue([])
    mockDb.submissionEvent.findMany.mockResolvedValue([])
  }

  // The service builds one AND array per source; the cursor bound is
  // appended as a second element, so the filter clause is AND[0].
  const firstAnd = (calls: unknown[][]) =>
    (calls[0][0] as { where: { AND: Record<string, unknown>[] } }).where.AND[0]

  it("filters by actor across all four sources", async () => {
    emptyMocks()
    await listActivityFeed(ownerActor(), baseFilters({ actorId: "admin-9" }))
    expect(firstAnd(mockDb.auditLog.findMany.mock.calls).userId).toBe("admin-9")
    expect(firstAnd(mockDb.subscriptionEvent.findMany.mock.calls).adminId).toBe(
      "admin-9"
    )
    expect(firstAnd(mockDb.billingEvent.findMany.mock.calls).userId).toBe(
      "admin-9"
    )
    expect(firstAnd(mockDb.submissionEvent.findMany.mock.calls).actorId).toBe(
      "admin-9"
    )
  })

  it("maps resourceType SUBSCRIPTION to audit + subscription events only", async () => {
    emptyMocks()
    await listActivityFeed(
      ownerActor(),
      baseFilters({ resourceType: "SUBSCRIPTION" })
    )
    expect(firstAnd(mockDb.auditLog.findMany.mock.calls).resourceType).toBe(
      "SUBSCRIPTION"
    )
    expect(mockDb.subscriptionEvent.findMany).toHaveBeenCalled()
    expect(mockDb.billingEvent.findMany).not.toHaveBeenCalled()
    expect(mockDb.submissionEvent.findMany).not.toHaveBeenCalled()
  })

  it("maps resourceType BILLING_PROVIDER to audit + billing events only", async () => {
    emptyMocks()
    await listActivityFeed(
      ownerActor(),
      baseFilters({ resourceType: "BILLING_PROVIDER" })
    )
    expect(mockDb.billingEvent.findMany).toHaveBeenCalled()
    expect(mockDb.subscriptionEvent.findMany).not.toHaveBeenCalled()
    expect(mockDb.submissionEvent.findMany).not.toHaveBeenCalled()
  })

  it("restricts outcome-filtered feeds to audit rows (only they carry an outcome)", async () => {
    emptyMocks()
    await listActivityFeed(ownerActor(), baseFilters({ outcome: "FAILED" }))
    expect(firstAnd(mockDb.auditLog.findMany.mock.calls).outcome).toBe("FAILED")
    expect(mockDb.subscriptionEvent.findMany).not.toHaveBeenCalled()
    expect(mockDb.billingEvent.findMany).not.toHaveBeenCalled()
    expect(mockDb.submissionEvent.findMany).not.toHaveBeenCalled()
  })

  it("applies the date range to every source", async () => {
    emptyMocks()
    await listActivityFeed(
      ownerActor(),
      baseFilters({
        from: "2026-11-01T00:00:00.000Z",
        to: "2026-11-26T00:00:00.000Z",
      })
    )
    for (const mock of [
      mockDb.auditLog.findMany,
      mockDb.subscriptionEvent.findMany,
      mockDb.billingEvent.findMany,
      mockDb.submissionEvent.findMany,
    ]) {
      const createdAt = (
        firstAnd(mock.mock.calls) as { createdAt: { gte: Date; lte: Date } }
      ).createdAt
      expect(createdAt.gte.toISOString()).toBe("2026-11-01T00:00:00.000Z")
      expect(createdAt.lte.toISOString()).toBe("2026-11-26T00:00:00.000Z")
    }
  })

  it("free-text q matches the resource id on every source", async () => {
    emptyMocks()
    await listActivityFeed(ownerActor(), baseFilters({ q: "user-7" }))
    expect(
      (
        firstAnd(mockDb.auditLog.findMany.mock.calls) as {
          resourceId: { contains: string }
        }
      ).resourceId.contains
    ).toBe("user-7")
    expect(
      (
        firstAnd(mockDb.subscriptionEvent.findMany.mock.calls) as {
          subscriptionId: { contains: string }
        }
      ).subscriptionId.contains
    ).toBe("user-7")
    expect(
      (
        firstAnd(mockDb.billingEvent.findMany.mock.calls) as {
          providerEventId: { contains: string }
        }
      ).providerEventId.contains
    ).toBe("user-7")
    expect(
      (
        firstAnd(mockDb.submissionEvent.findMany.mock.calls) as {
          submissionId: { contains: string }
        }
      ).submissionId.contains
    ).toBe("user-7")
  })

  it("rejects an unknown resourceType / outcome with 422", async () => {
    emptyMocks()
    await expect(
      listActivityFeed(ownerActor(), baseFilters({ resourceType: "NOPE" }))
    ).rejects.toMatchObject({ status: 422 })
    await expect(
      listActivityFeed(ownerActor(), baseFilters({ outcome: "MAYBE" }))
    ).rejects.toMatchObject({ status: 422 })
    expect(mockDb.auditLog.findMany).not.toHaveBeenCalled()
  })

  it("includes only admin-relevant submission types (no inbox noise)", async () => {
    emptyMocks()
    await listActivityFeed(ownerActor(), baseFilters())
    const typeIn = (
      firstAnd(mockDb.submissionEvent.findMany.mock.calls) as {
        type: { in: string[] }
      }
    ).type.in
    expect([...typeIn].sort()).toEqual([
      "EMAIL_FAILED",
      "EMAIL_QUEUED",
      "EMAIL_SENT",
      "MARKED_SPAM",
    ])
    expect(ACTIVITY_SUBMISSION_TYPES).toEqual(
      expect.arrayContaining(["MARKED_SPAM", "EMAIL_SENT", "EMAIL_FAILED"])
    )
    expect(ACTIVITY_SUBMISSION_TYPES).not.toContain("CREATED")
    expect(ACTIVITY_SUBMISSION_TYPES).not.toContain("READ")
    expect(ACTIVITY_SUBMISSION_TYPES).not.toContain("ARCHIVED")
  })
})

describe("activityTabForRow — one tab per row", () => {
  it("maps sources to tabs", () => {
    const row = (
      source: "audit" | "subscription" | "billing" | "submission",
      kind: string
    ) => ({ source, kind })
    expect(activityTabForRow(row("audit", "audit:USER:UPDATE"))).toBe("users")
    expect(activityTabForRow(row("audit", "audit:SUPPORT_TICKET:UPDATE"))).toBe(
      "support"
    )
    expect(activityTabForRow(row("audit", "audit:AI_KEY:CREATE"))).toBe("ai")
    expect(activityTabForRow(row("audit", "audit:PLAN:PUBLISH"))).toBe("all")
    expect(activityTabForRow(row("subscription", "subscription:RENEWED"))).toBe(
      "users"
    )
    expect(
      activityTabForRow(row("subscription", "subscription:PAYMENT_FAILED"))
    ).toBe("billing")
    expect(
      activityTabForRow(row("subscription", "subscription:REFUNDED"))
    ).toBe("billing")
    expect(activityTabForRow(row("billing", "billing:PAYMENT_SUCCEEDED"))).toBe(
      "billing"
    )
    expect(activityTabForRow(row("submission", "submission:MARKED_SPAM"))).toBe(
      "support"
    )
  })

  it("tab=users admits audit USER rows + non-billing subscription rows only", async () => {
    mockDb.auditLog.findMany.mockResolvedValue([])
    mockDb.subscriptionEvent.findMany.mockResolvedValue([])
    mockDb.billingEvent.findMany.mockResolvedValue([])
    mockDb.submissionEvent.findMany.mockResolvedValue([])
    await listActivityFeed(ownerActor(), baseFilters({ tab: "users" }))
    expect(firstAndTab(mockDb.auditLog.findMany.mock.calls).resourceType).toBe(
      "USER"
    )
    const subWhere = mockDb.subscriptionEvent.findMany.mock.calls[0][0] as {
      where: { AND: Record<string, unknown>[] }
    }
    const subClause = subWhere.where.AND[0] as {
      type: { notIn: string[] }
    }
    expect(subClause.type.notIn).toEqual(["PAYMENT_FAILED", "REFUNDED"])
    expect(mockDb.billingEvent.findMany).not.toHaveBeenCalled()
    expect(mockDb.submissionEvent.findMany).not.toHaveBeenCalled()
  })

  it("tab=billing admits billing rows + money-movement subscription rows only", async () => {
    mockDb.auditLog.findMany.mockResolvedValue([])
    mockDb.subscriptionEvent.findMany.mockResolvedValue([])
    mockDb.billingEvent.findMany.mockResolvedValue([])
    mockDb.submissionEvent.findMany.mockResolvedValue([])
    await listActivityFeed(ownerActor(), baseFilters({ tab: "billing" }))
    expect(mockDb.auditLog.findMany).not.toHaveBeenCalled()
    const subWhere = mockDb.subscriptionEvent.findMany.mock.calls[0][0] as {
      where: { AND: Record<string, unknown>[] }
    }
    const subClause = subWhere.where.AND[0] as { type: { in: string[] } }
    expect(subClause.type.in).toEqual(["PAYMENT_FAILED", "REFUNDED"])
    expect(mockDb.billingEvent.findMany).toHaveBeenCalled()
    expect(mockDb.submissionEvent.findMany).not.toHaveBeenCalled()
  })
})

// Local helper for the tab tests (same AND[0] shape as above).
function firstAndTab(calls: unknown[][]) {
  return (calls[0][0] as { where: { AND: Record<string, unknown>[] } }).where
    .AND[0]
}

describe("listActivityFeed — capability gate", () => {
  it("denies a plain user with 403 (VIEW_AUDIT_LOGS)", async () => {
    await expect(
      listActivityFeed(plainUserActor(), baseFilters())
    ).rejects.toMatchObject({ status: 403 })
    expect(mockDb.auditLog.findMany).not.toHaveBeenCalled()
  })

  it("denies SUPPORT staff with 403, same as /admin/audit-logs", async () => {
    await expect(
      listActivityFeed(supportActor(), baseFilters())
    ).rejects.toMatchObject({ status: 403 })
    expect(mockDb.auditLog.findMany).not.toHaveBeenCalled()
  })

  it("admits MANAGER staff", async () => {
    mockDb.auditLog.findMany.mockResolvedValue([])
    mockDb.subscriptionEvent.findMany.mockResolvedValue([])
    mockDb.billingEvent.findMany.mockResolvedValue([])
    mockDb.submissionEvent.findMany.mockResolvedValue([])
    const feed = await listActivityFeed(managerActor(), baseFilters())
    expect(feed.rows).toEqual([])
    expect(mockDb.auditLog.findMany).toHaveBeenCalled()
  })
})

describe("GET /api/v1/admin/activity — thin route", () => {
  it("returns the merged feed and gates on VIEW_AUDIT_LOGS", async () => {
    mockDb.auditLog.findMany.mockResolvedValue([
      auditRow("a1", "2026-11-26T10:00:00.000Z"),
    ])
    mockDb.subscriptionEvent.findMany.mockResolvedValue([])
    mockDb.billingEvent.findMany.mockResolvedValue([])
    mockDb.submissionEvent.findMany.mockResolvedValue([])
    const res = await GET(
      new NextRequest("http://localhost:3001/api/v1/admin/activity")
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      rows: { id: string }[]
      nextCursor: string | null
    }
    expect(body.rows.map((row) => row.id)).toEqual(["audit:a1"])
    expect(body.nextCursor).toBeNull()
    expect(mockRequireAdminApi).toHaveBeenCalledWith("VIEW_AUDIT_LOGS")
  })

  it("returns 403 when the actor lacks VIEW_AUDIT_LOGS", async () => {
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Forbidden", 403))
    const res = await GET(
      new NextRequest("http://localhost:3001/api/v1/admin/activity")
    )
    expect(res.status).toBe(403)
    expect(mockDb.auditLog.findMany).not.toHaveBeenCalled()
  })

  it("returns 422 for an unparseable from date", async () => {
    const res = await GET(
      new NextRequest(
        "http://localhost:3001/api/v1/admin/activity?from=not-a-date"
      )
    )
    expect(res.status).toBe(422)
    expect(mockDb.auditLog.findMany).not.toHaveBeenCalled()
  })

  it("returns the rate-limit response instead of the feed", async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(
      new NextResponse(null, { status: 429 })
    )
    const res = await GET(
      new NextRequest("http://localhost:3001/api/v1/admin/activity")
    )
    expect(res.status).toBe(429)
    expect(mockDb.auditLog.findMany).not.toHaveBeenCalled()
  })
})

describe("Activity page — wiring", () => {
  it("has the page, route, feed component, and loading/error boundaries", () => {
    for (const rel of [
      "apps/admin/app/admin/activity/page.tsx",
      "apps/api/app/api/v1/admin/activity/route.ts",
      "apps/admin/components/admin/activity-feed.tsx",
      "apps/admin/app/admin/activity/loading.tsx",
      "apps/admin/app/admin/activity/error.tsx",
      "packages/i18n/locales/en/admin/activity.json",
      "packages/i18n/locales/ur/admin/activity.json",
      "packages/modules/platform-ops/src/activity.ts",
    ]) {
      expect(existsSync(path.join(root, rel)), rel).toBe(true)
    }
  })

  it("page authenticates and renders the feed, no PageHeader action slot", () => {
    const src = read("apps/admin/app/admin/activity/page.tsx")
    expect(src).toContain('getTranslator(locale, "activity")')
    expect(src).toContain("ActivityFeed")
    expect(src).toContain("actorRole")
    // Read-only feed (UX-110): no single primary action.
    expect(src).not.toContain("action={")
  })

  it("feed has the five tabs, shared EmptyState, and the audit detail dialog", () => {
    const src = read("apps/admin/components/admin/activity-feed.tsx")
    for (const value of ["all", "users", "billing", "ai", "support"]) {
      expect(src).toContain(`TabsTrigger value="${value}"`)
    }
    expect(src).toContain("EmptyState")
    expect(src).toContain("useActivityFeed")
    expect(src).toContain("useAuditLog")
    expect(src).toContain("loadMore")
    // Bundle boundary: the resource options come from the
    // client-safe copy, never from the platform-ops barrel (which
    // would drag `db` into the browser bundle).
    expect(src).toContain('from "./audit-filter-options"')
    expect(src).not.toContain('AUDIT_RESOURCES } from "@sendcms/platform-ops"')
    expect(src).not.toContain("revalidatePath")
  })

  it("route is thin, gated VIEW_AUDIT_LOGS, and never imports the database", () => {
    const src = read("apps/api/app/api/v1/admin/activity/route.ts")
    expect(src).toContain('requireAdminApi("VIEW_AUDIT_LOGS")')
    expect(src).toContain("listActivityFeed(session, parsed.data)")
    expect(src).toContain("return ok(feed)")
    expect(src).not.toContain("@sendcms/database")
    expect(src).not.toContain("revalidatePath")
  })

  it("loading skeleton mirrors the page shape; error boundary is generic (SEC-107)", () => {
    const loading = read("apps/admin/app/admin/activity/loading.tsx")
    expect(loading).toContain("Skeleton")
    const error = read("apps/admin/app/admin/activity/error.tsx")
    expect(error).toContain('createLogger("activity-error")')
    expect(error).toContain('t("errorTitle")')
    expect(error).not.toContain("error.message")
  })

  it("activity i18n exists in en + ur with identical key sets", () => {
    const en = readJson("packages/i18n/locales/en/admin/activity.json")
    const ur = readJson("packages/i18n/locales/ur/admin/activity.json")
    expect(Object.keys(ur).sort()).toEqual(Object.keys(en).sort())
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim().length, `en:${key}`).toBeGreaterThan(0)
      expect(ur[key].trim().length, `ur:${key}`).toBeGreaterThan(0)
    }
    for (const key of [
      "title",
      "tabAll",
      "tabUsers",
      "tabBilling",
      "tabAi",
      "tabSupport",
    ]) {
      expect(en[key]).toBeDefined()
    }
  })

  it("activity domain is registered for the admin client shell", () => {
    // The packages/i18n loader registration (ADMIN_DOMAINS) and the
    // sidebar + capability map are consolidation-owned; this page
    // only asserts the wiring it owns — the shell list that feeds
    // the client TranslationProvider.
    expect(read("apps/admin/lib/i18n.ts")).toContain('"activity",')
  })

  it("nav key activity exists in en + ur navigation.json (no new nav key needed)", () => {
    expect(
      readJson("packages/i18n/locales/en/admin/navigation.json").activity
    ).toBe("Activity")
    expect(
      readJson("packages/i18n/locales/ur/admin/navigation.json").activity
    ).toBe("سرگرمی")
  })

  it("service reuses the audit module's gate and never imports Next.js", () => {
    const src = read("packages/modules/platform-ops/src/activity.ts")
    expect(src).toContain('requireAdmin(actor, "VIEW_AUDIT_LOGS")')
    expect(src).not.toContain("next/")
    expect(src).toContain("listActivityFeed")
  })
})
