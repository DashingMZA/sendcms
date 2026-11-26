// Phase A Worker C — Trials page (plan §3.4, Q4 = DERIVE).
//
// getTrialStats / listEndedTrials aggregation with a mocked Prisma
// client (no test hits the real DB), plus static regression tests
// guarding the wiring (page, table, stats route shape, i18n keys,
// loading/error boundaries). The capability map + sidebar +
// tests/permissions.test.ts are coordinator-owned and intentionally
// NOT asserted here.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  subscription: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
  subscriptionEvent: {
    findMany: vi.fn(),
  },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

import type { AdminSession } from "@sendcms/auth"
import { getTrialStats, listEndedTrials } from "@sendcms/plans"

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

// Pinned clock (UTC ISO strings — no local-timezone dependence):
// now = 2026-11-26T00:00:00Z, so "within 7 days" ends
// 2026-12-03T00:00:00Z and "last 30 days" starts 2026-10-27T00:00:00Z.
const NOW = new Date("2026-11-26T00:00:00.000Z")

beforeEach(() => {
  vi.clearAllMocks()
})

describe("getTrialStats", () => {
  it("counts active trials and expiring trials from currentPeriodEnd", async () => {
    mockDb.subscription.count.mockImplementation(
      async (args: { where?: { currentPeriodEnd?: unknown } }) =>
        args?.where?.currentPeriodEnd ? 2 : 5
    )
    mockDb.subscriptionEvent.findMany.mockResolvedValue([])
    const stats = await getTrialStats(ownerActor(), NOW)
    expect(stats.activeTrials).toBe(5)
    expect(stats.expiringSoon).toBe(2)
    // The expiring window is the DERIVED trial end: TRIALING rows
    // whose currentPeriodEnd falls within now + 7 days. There is no
    // trialEndAt column — the bound must be on currentPeriodEnd.
    const expiringCall = mockDb.subscription.count.mock.calls.find(
      (call) =>
        (call[0] as { where?: { currentPeriodEnd?: unknown } }).where
          ?.currentPeriodEnd !== undefined
    )
    expect(expiringCall).toBeDefined()
    const where = (
      expiringCall as unknown as [
        {
          where: {
            status: string
            currentPeriodEnd: { lte: Date }
          }
        },
      ]
    )[0].where
    expect(where.status).toBe("TRIALING")
    expect(where.currentPeriodEnd.lte.toISOString()).toBe(
      "2026-12-03T00:00:00.000Z"
    )
    const activeCall = mockDb.subscription.count.mock.calls.find(
      (call) =>
        (call[0] as { where?: { currentPeriodEnd?: unknown } }).where
          ?.currentPeriodEnd === undefined
    )
    expect(
      (activeCall as unknown as [{ where: { status: string } }])[0].where.status
    ).toBe("TRIALING")
  })

  it("derives converted/expired from SubscriptionEvent history, trial-origin only", async () => {
    mockDb.subscription.count.mockResolvedValue(0)
    mockDb.subscriptionEvent.findMany.mockImplementation(
      async (args: { where?: { type?: string | { in?: string[] } } }) => {
        if (args?.where?.type === "CREATED") {
          // Two trial origins (one duplicated CREATED row, deduped)
          // plus one paid origin with no trial marker.
          return [
            { subscriptionId: "sub-trial-1" },
            { subscriptionId: "sub-trial-2" },
            { subscriptionId: "sub-trial-3" },
            { subscriptionId: "sub-trial-1" },
          ]
        }
        return [
          // Trial 1 renewed in the window → converted.
          { subscriptionId: "sub-trial-1", type: "RENEWED", reason: null },
          // A paid subscription renewing is NOT a conversion.
          { subscriptionId: "sub-paid-1", type: "RENEWED", reason: null },
          // Trial 2 expired in the window → expired.
          { subscriptionId: "sub-trial-2", type: "EXPIRED", reason: null },
          // Trial 3 superseded by a new checkout → neither converted
          // nor expired (a replacement, not an ending).
          {
            subscriptionId: "sub-trial-3",
            type: "CANCELED",
            reason: "Superseded by checkout via STRIPE",
          },
        ]
      }
    )
    const stats = await getTrialStats(ownerActor(), NOW)
    expect(stats.convertedLast30Days).toBe(1)
    expect(stats.expiredLast30Days).toBe(1)
    // The trial-origin query is the CREATED event reason marker the
    // checkout writer emits ("trial until"); the outcome query is
    // windowed to the last 30 days.
    const createdCall = mockDb.subscriptionEvent.findMany.mock.calls.find(
      (call) =>
        (call[0] as { where?: { type?: unknown } }).where?.type === "CREATED"
    )
    expect(createdCall).toBeDefined()
    expect(
      (
        createdCall as unknown as [{ where: { reason: { contains: string } } }]
      )[0].where.reason.contains
    ).toBe("trial until")
    const outcomeCall = mockDb.subscriptionEvent.findMany.mock.calls.find(
      (call) =>
        (call[0] as { where?: { type?: unknown } }).where?.type !== "CREATED"
    )
    expect(outcomeCall).toBeDefined()
    expect(
      (
        outcomeCall as unknown as [{ where: { createdAt: { gte: Date } } }]
      )[0].where.createdAt.gte.toISOString()
    ).toBe("2026-10-27T00:00:00.000Z")
  })

  it("denies a plain user with 403 (VIEW_USERS)", async () => {
    await expect(getTrialStats(plainUserActor(), NOW)).rejects.toMatchObject({
      status: 403,
    })
    expect(mockDb.subscription.count).not.toHaveBeenCalled()
  })
})

describe("listEndedTrials", () => {
  it("lists trial-origin subscriptions in EXPIRED/CANCELED, same shape as listSubscriptions", async () => {
    mockDb.subscriptionEvent.findMany.mockResolvedValue([
      { subscriptionId: "sub-trial-1" },
      { subscriptionId: "sub-trial-2" },
    ])
    mockDb.subscription.count.mockResolvedValue(2)
    const row = {
      id: "sub-trial-2",
      userId: "user-1",
      user: { id: "user-1", name: "Trial User", email: "trial@example.com" },
      planId: "plan-1",
      plan: { id: "plan-1", name: "Pro", slug: "pro" },
      planVersionId: "ver-1",
      planVersion: {
        id: "ver-1",
        planId: "plan-1",
        plan: { name: "Pro" },
        version: 2,
        priceAmount: 1000,
        priceCurrency: "USD",
        billingInterval: "MONTHLY",
        trialDays: 14,
      },
      status: "EXPIRED",
      provider: "STRIPE",
      providerSubscriptionId: "sub_123",
      currentPeriodStart: new Date("2026-11-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-11-15T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      createdAt: new Date("2026-11-01T00:00:00.000Z"),
      updatedAt: new Date("2026-11-15T00:00:00.000Z"),
    }
    mockDb.subscription.findMany.mockResolvedValue([row])
    const result = await listEndedTrials(ownerActor(), {
      page: 1,
      perPage: 20,
      sort: "createdAt:desc",
    })
    expect(result.total).toBe(2)
    expect(result.subscriptions).toHaveLength(1)
    // The trial end the row carries is currentPeriodEnd — the same
    // field the subscription detail displays.
    expect(result.subscriptions[0].currentPeriodEnd?.toISOString()).toBe(
      "2026-11-15T00:00:00.000Z"
    )
    const where = mockDb.subscription.findMany.mock.calls[0][0].where as {
      id: { in: string[] }
      status: { in: string[] }
    }
    expect(where.id.in).toEqual(["sub-trial-1", "sub-trial-2"])
    expect(where.status.in).toEqual(["EXPIRED", "CANCELED"])
  })

  it("denies a plain user with 403 (VIEW_USERS)", async () => {
    await expect(
      listEndedTrials(plainUserActor(), {
        page: 1,
        perPage: 20,
        sort: "createdAt:desc",
      })
    ).rejects.toMatchObject({ status: 403 })
  })
})

describe("Trials page — wiring", () => {
  it("has the page, stats route, table, and loading/error boundaries", () => {
    for (const rel of [
      "apps/admin/app/admin/trials/page.tsx",
      "apps/api/app/api/v1/admin/trials/stats/route.ts",
      "apps/admin/components/admin/trials-table.tsx",
      "apps/admin/app/admin/trials/loading.tsx",
      "apps/admin/app/admin/trials/error.tsx",
      "packages/i18n/locales/en/admin/trials.json",
      "packages/i18n/locales/ur/admin/trials.json",
    ]) {
      expect(existsSync(path.join(root, rel)), rel).toBe(true)
    }
  })

  it("page fetches stats + lists via the service layer, no PageHeader action slot", () => {
    const src = read("apps/admin/app/admin/trials/page.tsx")
    expect(src).toContain("getTrialStats(session, now)")
    expect(src).toContain("listSubscriptions(session,")
    expect(src).toContain('status: "TRIALING"')
    expect(src).toContain("listEndedTrials(session, filters)")
    expect(src).toContain("TrialsTable")
    expect(src).toContain("StatCard")
    expect(src).toContain('getTranslator(locale, "trials")')
    // No single primary action on this page (UX-110): no action slot.
    expect(src).not.toContain("action={")
    // The expiring tab bounds on the derived trial end.
    expect(src).toContain("endsBefore: endsBefore.toISOString()")
  })

  it("table has the three tabs, shared EmptyState, and links to the existing detail", () => {
    const src = read("apps/admin/components/admin/trials-table.tsx")
    expect(src).toContain('TabsTrigger value="active"')
    expect(src).toContain('TabsTrigger value="expiring"')
    expect(src).toContain('TabsTrigger value="ended"')
    expect(src).toContain("EmptyState")
    expect(src).toContain("subscriptionStatusLabel")
    // Same period cell as subscriptions-table: the trial end is
    // currentPeriodEnd, the field the detail displays.
    expect(src).toContain("subscription.currentPeriodEnd")
    expect(src).toContain("formatDate(locale, subscription.currentPeriodEnd)")
    // Row action is a single ghost link to the existing detail
    // (UX-111); no new cancel/extend/convert actions in v1.
    expect(src).toContain("href={`/admin/all-users/${subscription.userId}`}")
    expect(src).toContain('variant="ghost"')
    expect(src).not.toContain("AssignDialog")
    expect(src).not.toContain("CancelDialog")
  })

  it("stats route is thin, gated VIEW_USERS, and never imports the database", () => {
    const src = read("apps/api/app/api/v1/admin/trials/stats/route.ts")
    expect(src).toContain('requireAdminApi("VIEW_USERS")')
    expect(src).toContain("getTrialStats(session)")
    expect(src).toContain("return ok(stats)")
    expect(src).not.toContain("@sendcms/database")
    expect(src.split("\n").length).toBeLessThanOrEqual(25)
  })

  it("trial-end derivation matches the subscription detail's displayed end date", () => {
    // The detail (user Package tab) displays currentPeriodEnd; the
    // service derives the trial end from the same field, and the
    // trials table renders the same period cell. No trialEndAt
    // column exists anywhere in the chain.
    const detail = read("apps/admin/components/admin/user-package-tab.tsx")
    expect(detail).toContain("subscription.currentPeriodEnd")
    const service = read("packages/modules/plans/src/service.ts")
    expect(service).toContain(
      'where: { status: "TRIALING", currentPeriodEnd: { lte: in7Days } }'
    )
    expect(service).not.toContain("trialEndAt")
    const schema = read("packages/database/prisma/schema.prisma")
    expect(schema).not.toContain("trialEndAt")
    expect(schema).not.toContain("model Trial")
  })

  it("loading skeleton mirrors the page shape; error boundary is generic (SEC-107)", () => {
    const loading = read("apps/admin/app/admin/trials/loading.tsx")
    expect(loading).toContain("Skeleton")
    expect(loading).toContain("lg:grid-cols-4")
    const error = read("apps/admin/app/admin/trials/error.tsx")
    expect(error).toContain('createLogger("trials-error")')
    expect(error).toContain('t("errorTitle")')
    expect(error).not.toContain("error.message")
  })

  it("trials i18n exists in en + ur with identical key sets", () => {
    const en = readJson("packages/i18n/locales/en/admin/trials.json")
    const ur = readJson("packages/i18n/locales/ur/admin/trials.json")
    expect(Object.keys(ur).sort()).toEqual(Object.keys(en).sort())
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim().length, `en:${key}`).toBeGreaterThan(0)
      expect(ur[key].trim().length, `ur:${key}`).toBeGreaterThan(0)
    }
    for (const key of ["title", "tabActive", "tabExpiring", "tabEnded"]) {
      expect(en[key]).toBeDefined()
    }
  })

  it("trials domain is registered for server + client translation loading", () => {
    expect(read("packages/i18n/src/load.ts")).toContain('"trials",')
    expect(read("apps/admin/lib/i18n.ts")).toContain('"trials",')
  })

  it("nav key trials exists in en + ur navigation.json (no new nav key needed)", () => {
    expect(
      readJson("packages/i18n/locales/en/admin/navigation.json").trials
    ).toBe("Trials")
    expect(
      readJson("packages/i18n/locales/ur/admin/navigation.json").trials
    ).toBe("ٹرائلز")
  })
})
