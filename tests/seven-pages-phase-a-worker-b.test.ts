// Phase A Worker B — Plans & Subscriptions combined page (plan §3.3,
// Q3 = VIEW_USERS). No test here hits the real DB: the service tests
// use the same mocked-Prisma pattern as tests/plans.test.ts, and the
// wiring tests are static file reads in the Worker A style.
//
// DEPENDENCY (coordinator-owned): the capability-gate test in the
// "capability gate" block asserts the PLATFORM_ROUTE_CAPABILITY entry
// the coordinator adds in packages/permissions/src/platform.ts
// ("/admin/plans-subscriptions" = "VIEW_USERS") plus the matching
// sidebar item and tests/permissions.test.ts update. That one test
// FAILS until the coordinator applies the one-line map edit —
// everything else in this file passes without it.
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PLATFORM_ROUTE_CAPABILITY, adminCan } from "@sendcms/permissions"
import { listPlans, listSubscriptions } from "@sendcms/plans"
import {
  PlanListQuerySchema,
  SubscriptionListQuerySchema,
} from "@sendcms/plans/validators"
import type { AdminSession } from "@sendcms/auth"
import { getPlansSubscriptionsStats } from "../apps/admin/lib/plans-subscriptions-stats"

const root = process.cwd()
const read = (rel: string) => readFileSync(path.join(root, rel), "utf-8")

function readJson(rel: string): Record<string, string> {
  return JSON.parse(read(rel)) as Record<string, string>
}

const mockLogAudit = vi.hoisted(() => vi.fn(async () => {}))

const mockDb = vi.hoisted(() => ({
  plan: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
  subscription: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
}))

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/security")>()
  return { ...actual, logAudit: mockLogAudit }
})

function makeActor(
  overrides: Partial<AdminSession["user"]> = {}
): AdminSession {
  return {
    user: {
      id: "owner-1",
      name: "Owner",
      email: "owner@example.com",
      image: null,
      platformRole: "PLATFORM_OWNER",
      status: "ACTIVE",
      adminRole: null,
      emailVerified: true,
      ...overrides,
    },
    session: {
      id: "sess-1",
      userId: "owner-1",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    },
  }
}

const ownerActor = () => makeActor()

describe("Plans & Subscriptions — capability gate (Q3, approved)", () => {
  it("is gated on VIEW_USERS in PLATFORM_ROUTE_CAPABILITY", () => {
    // Coordinator-owned map entry — see the file header. This test
    // fails until the coordinator adds
    // "/admin/plans-subscriptions": "VIEW_USERS" to
    // packages/permissions/src/platform.ts.
    expect(PLATFORM_ROUTE_CAPABILITY["/admin/plans-subscriptions"]).toBe(
      "VIEW_USERS"
    )
  })

  it("keeps SUPPORT's access to the subscriptions half", () => {
    // SUPPORT has VIEW_USERS (the page gate) but not
    // VIEW_PLAN_VERSIONS (the plans half) — the page hides the Plans
    // tab for them instead of denying the whole page.
    expect(adminCan("SUPPORT", "VIEW_USERS")).toBe(true)
    expect(adminCan("SUPPORT", "VIEW_PLAN_VERSIONS")).toBe(false)
    expect(adminCan("MANAGER", "VIEW_USERS")).toBe(true)
    expect(adminCan("SUPER_ADMIN", "VIEW_USERS")).toBe(true)
    expect(adminCan("PLATFORM_USER", "VIEW_USERS")).toBe(false)
  })
})

describe("Plans & Subscriptions — stat-row counts reconcile with the two lists", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.plan.findMany.mockResolvedValue([])
    mockDb.subscription.findMany.mockResolvedValue([])
  })

  it("published-plans stat equals the plans list total for status=PUBLISHED", async () => {
    mockDb.plan.count.mockResolvedValue(7)
    mockDb.subscription.count.mockResolvedValue(0)
    const stats = await getPlansSubscriptionsStats(ownerActor(), true)
    expect(stats.plansPublished).toBe(7)
    // The same query the /admin/plans table runs for the same filter.
    const list = await listPlans(ownerActor(), {
      page: 1,
      perPage: 20,
      sort: "createdAt:desc",
      status: "PUBLISHED",
    })
    expect(list.total).toBe(7)
    expect(stats.plansPublished).toBe(list.total)
    // The stat read only the total: one row at most.
    expect(mockDb.plan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1 })
    )
    expect(mockDb.plan.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "PUBLISHED" }),
      })
    )
  })

  it("subscription stats equal the subscriptions list totals per status", async () => {
    mockDb.plan.count.mockResolvedValue(0)
    mockDb.subscription.count.mockImplementation(
      (args: { where?: { status?: string } }) => {
        const byStatus: Record<string, number> = {
          ACTIVE: 11,
          TRIALING: 3,
          PAST_DUE: 2,
        }
        return Promise.resolve(byStatus[args.where?.status ?? ""] ?? 0)
      }
    )
    const stats = await getPlansSubscriptionsStats(ownerActor(), true)
    expect(stats).toMatchObject({
      subscriptionsActive: 11,
      subscriptionsTrialing: 3,
      subscriptionsPastDue: 2,
    })
    for (const [status, total] of [
      ["ACTIVE", 11],
      ["TRIALING", 3],
      ["PAST_DUE", 2],
    ] as const) {
      const list = await listSubscriptions(ownerActor(), {
        page: 1,
        perPage: 20,
        sort: "createdAt:desc",
        status,
      })
      expect(list.total, status).toBe(total)
    }
    expect(stats.subscriptionsActive).toBe(11)
    expect(stats.subscriptionsTrialing).toBe(3)
    expect(stats.subscriptionsPastDue).toBe(2)
    expect(mockDb.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1 })
    )
  })

  it("omits the plans count — and never calls listPlans — without VIEW_PLAN_VERSIONS", async () => {
    mockDb.subscription.count.mockResolvedValue(4)
    const stats = await getPlansSubscriptionsStats(ownerActor(), false)
    expect(stats.plansPublished).toBeNull()
    expect(stats.subscriptionsActive).toBe(4)
    expect(mockDb.plan.count).not.toHaveBeenCalled()
    expect(mockDb.plan.findMany).not.toHaveBeenCalled()
  })
})

describe("Plans & Subscriptions — shared URL query string", () => {
  it("rejects the other table's status/sort in each schema (the hazard)", () => {
    // The two tables share one URL query string, but their enums are
    // disjoint: a status left by one table is invalid for the other.
    expect(PlanListQuerySchema.safeParse({ status: "ACTIVE" }).success).toBe(
      false
    )
    expect(
      SubscriptionListQuerySchema.safeParse({ status: "PUBLISHED" }).success
    ).toBe(false)
    expect(
      SubscriptionListQuerySchema.safeParse({ sort: "name:asc" }).success
    ).toBe(false)
  })

  it("recovers to schema defaults (the page's safeParse fallback)", () => {
    expect(PlanListQuerySchema.parse({})).toEqual({
      page: 1,
      perPage: 20,
      sort: "createdAt:desc",
    })
    expect(SubscriptionListQuerySchema.parse({})).toEqual({
      page: 1,
      perPage: 20,
      sort: "createdAt:desc",
    })
  })
})

describe("Plans & Subscriptions — page wiring", () => {
  const page = () => read("apps/admin/app/admin/plans-subscriptions/page.tsx")

  it("composes the two existing tables with the same services and filters", () => {
    const src = page()
    expect(src).toContain("listPlans")
    expect(src).toContain("listSubscriptions")
    expect(src).toContain("PlansTable")
    expect(src).toContain("SubscriptionsTable")
    expect(src).toContain("PlansSubscriptionsTabs")
    expect(src).toContain("PageHeader")
    expect(src).toContain("StatCard")
    expect(src).toContain('getTranslator(locale, "plans-subscriptions")')
    expect(src).toContain("initialData={plansInitialData}")
    expect(src).toContain("initialData={subscriptionsInitialData}")
    expect(src).toContain("filters={plansFilters}")
    expect(src).toContain("filters={subscriptionsFilters}")
    expect(src).toContain("actorRole={actorRole}")
  })

  it("parses each table's filters with safeParse + defaults (shared URL)", () => {
    const src = page()
    expect(src).toContain("PlanListQuerySchema.safeParse")
    expect(src).toContain("SubscriptionListQuerySchema.safeParse")
    expect(src).toContain("PlanListQuerySchema.parse({})")
    expect(src).toContain("SubscriptionListQuerySchema.parse({})")
  })

  it("hides the plans half without VIEW_PLAN_VERSIONS and never calls listPlans for them", () => {
    const src = page()
    expect(src).toContain('adminCan(actorRole, "VIEW_PLAN_VERSIONS")')
    expect(src).toContain("canViewPlans")
  })

  it("adds no PageHeader action slot (no single primary action — do not invent one)", () => {
    expect(page()).not.toContain("action={")
  })

  it("adds no new service, model, API route, or migration", () => {
    const src = page()
    expect(src).not.toContain("@sendcms/database")
    expect(src).not.toContain("revalidatePath")
    expect(
      existsSync(
        path.join(root, "apps/api/app/api/v1/admin/plans-subscriptions")
      )
    ).toBe(false)
    expect(
      readdirSync(
        path.join(root, "apps/admin/app/admin/plans-subscriptions")
      ).sort()
    ).toEqual(["error.tsx", "loading.tsx", "page.tsx"])
  })
})

describe("Plans & Subscriptions — tabs shell wiring", () => {
  const tabs = () =>
    read("apps/admin/components/admin/plans-subscriptions-tabs.tsx")

  it("uses the shared Tabs with tab semantics (Wave 10 UX-105)", () => {
    const src = tabs()
    expect(src).toContain("Tabs, TabsContent, TabsList, TabsTrigger")
    expect(src).toContain('value="plans"')
    expect(src).toContain('value="subscriptions"')
    expect(src).toContain("TabsList")
    expect(src).toContain("TabsTrigger")
    expect(src).toContain("TabsContent")
  })

  it("receives the tables as nodes (composition — no server-only imports)", () => {
    const src = tabs()
    expect(src).toContain("plansTable?: ReactNode")
    expect(src).toContain("subscriptionsTable: ReactNode")
    expect(src).not.toContain("plans-table")
    expect(src).not.toContain("subscriptions-table")
    expect(src).not.toContain("@sendcms/database")
    expect(src).not.toContain("@sendcms/plans")
  })
})

describe("Plans & Subscriptions — i18n", () => {
  it("has the plansAndSubscriptions nav key in en + ur (the sidebar label)", () => {
    expect(
      readJson("packages/i18n/locales/en/admin/navigation.json")
        .plansAndSubscriptions
    ).toBe("Plans & Subscriptions")
    expect(
      readJson("packages/i18n/locales/ur/admin/navigation.json")
        .plansAndSubscriptions
    ).toBe("پلانز اور سبسکرپشنز")
  })

  it("has the plans-subscriptions domain file in en + ur with matching keys", () => {
    const en = readJson(
      "packages/i18n/locales/en/admin/plans-subscriptions.json"
    )
    const ur = readJson(
      "packages/i18n/locales/ur/admin/plans-subscriptions.json"
    )
    expect(Object.keys(en).sort()).toEqual(Object.keys(ur).sort())
    for (const key of [
      "title",
      "description",
      "tabPlans",
      "tabSubscriptions",
      "statPlansPublished",
      "statSubscriptionsActive",
      "statTrialing",
      "statPastDue",
    ]) {
      expect(en[key], `en.${key}`).toBeDefined()
      expect(ur[key], `ur.${key}`).toBeDefined()
    }
    expect(en.title).toBe("Plans & Subscriptions")
  })

  it("registers the domain for server + client translation loading", () => {
    expect(read("packages/i18n/src/load.ts")).toContain('"plans-subscriptions"')
    expect(read("apps/admin/lib/i18n.ts")).toContain('"plans-subscriptions"')
  })

  it("keeps table strings in plans.json / subscriptions.json (no duplicates)", () => {
    const en = readJson(
      "packages/i18n/locales/en/admin/plans-subscriptions.json"
    )
    expect(en.colPlan).toBeUndefined()
    expect(en.colStatus).toBeUndefined()
  })
})

describe("Plans & Subscriptions — loading + error boundaries", () => {
  it("adds loading.tsx + error.tsx for the new route (SRC-111 pattern)", () => {
    expect(
      existsSync(
        path.join(root, "apps/admin/app/admin/plans-subscriptions/loading.tsx")
      )
    ).toBe(true)
    expect(
      existsSync(
        path.join(root, "apps/admin/app/admin/plans-subscriptions/error.tsx")
      )
    ).toBe(true)
    expect(
      read("apps/admin/app/admin/plans-subscriptions/loading.tsx")
    ).toContain("Skeleton")
    const error = read("apps/admin/app/admin/plans-subscriptions/error.tsx")
    expect(error).toContain('"use client"')
    expect(error).toContain("createLogger")
    // SEC-107: generic message, never the error's own message.
    expect(error).not.toContain("error.message")
  })
})
