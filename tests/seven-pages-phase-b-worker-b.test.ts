// Phase B Worker B — Payments page (plan §3.5, Q5 + Q11).
// No test hits the real DB, a real provider, or the network: the
// service tests use the same mocked-Prisma pattern as
// tests/billing-events-customer-wave6.test.ts, the route tests the
// same mocked-gate pattern as
// tests/seven-pages-phase-a-worker-c-route.test.ts, and the wiring
// tests are static file reads in the Worker A style.
//
// DEPENDENCY (coordinator-owned): four tests FAIL until the
// coordinator applies the consolidation edits — the
// PLATFORM_ROUTE_CAPABILITY entry ("/admin/payments" =
// "VIEW_BILLING"), the sidebar item (`payments` next to `billing`
// in the Platform group), the ADMIN_DOMAINS entry ("payments" in
// packages/i18n/src/load.ts), and the matching
// tests/permissions.test.ts entry. Everything else passes without
// them. The translations cannot render (getTranslator falls back to
// the shared-domain path) until the load.ts entry lands — see the
// "i18n" block.
//
// TIME: no test asserts a locale-rendered clock time. getPaymentStats
// takes an explicit `now` argument, and the stats tests pass a
// pinned UTC instant; day buckets use toISOString (UTC), so no
// timeZone pinning is needed in an assertion.
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { ApiError } from "@sendcms/api-client"
import { PLATFORM_ROUTE_CAPABILITY, adminCan } from "@sendcms/permissions"
import type { AdminSession } from "@sendcms/auth"

const root = process.cwd()
const read = (rel: string) => readFileSync(path.join(root, rel), "utf-8")

function readJson(rel: string): Record<string, string> {
  return JSON.parse(read(rel)) as Record<string, string>
}

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
const managerActor = () =>
  makeActor({
    id: "mgr-1",
    platformRole: "PLATFORM_USER",
    adminRole: "MANAGER",
  })
const supportActor = () =>
  makeActor({
    id: "sup-1",
    platformRole: "PLATFORM_USER",
    adminRole: "SUPPORT",
  })

const NOW = new Date("2026-11-26T12:00:00Z")
const at = (iso: string) => new Date(iso)

// ─── Mocks ────────────────────────────────────────────────────────────

const mockLogAudit = vi.hoisted(() => vi.fn(async () => undefined))
const mockRequireStepUp = vi.hoisted(() =>
  vi.fn(async () => ({ verifiedUntil: new Date("2026-11-26T13:00:00Z") }))
)
const mockApplyRefund = vi.hoisted(() =>
  vi.fn(async (): Promise<{ id: string; status: string } | null> => null)
)
const mockActivate = vi.hoisted(() => vi.fn(async () => null))
const mockCancel = vi.hoisted(() => vi.fn(async () => null))
const mockExtend = vi.hoisted(() => vi.fn(async () => null))
const mockMarkPastDue = vi.hoisted(() => vi.fn(async () => null))
const mockSync = vi.hoisted(() => vi.fn(async () => null))
const mockVerify = vi.hoisted(() => vi.fn())

// Route-test mocks (Worker C pattern): the routes import the billing
// barrel, so it is mocked here; the service tests import the real
// service through its relative source path below.
const mockSession = { user: { id: "admin-1" } }
const mockRequireAdminApi = vi.hoisted(() => vi.fn(async () => mockSession))
const mockEnforceRateLimit = vi.hoisted(() =>
  vi.fn(async (): Promise<NextResponse | null> => null)
)
const mockListPayments = vi.hoisted(() =>
  vi.fn(async () => ({
    payments: [],
    total: 0,
    page: 1,
    perPage: 20,
    totalPages: 1,
  }))
)
const mockGetPaymentDetail = vi.hoisted(() =>
  vi.fn(async () => ({ payment: { id: "ev-1" } }))
)
const mockRefundPayment = vi.hoisted(() =>
  vi.fn(async () => ({ payment: { id: "ev-1" }, subscription: null }))
)

type StoredEvent = {
  id: string
  provider: string
  providerEventId: string
  eventType: string
  kind: string | null
  userId: string | null
  processedAt: Date | null
  createdAt: Date
}

type StoredPurchase = {
  id: string
  provider: string
  userId: string
  planVersionId: string
  subscriptionId: string | null
  providerReference: string
  checkoutId: string | null
  priceAmount: number | null
  priceCurrency: string
  status: string
  accessStart: Date
  accessEnd: Date
  createdAt: Date
}

type StoredAttempt = {
  id: string
  attemptId: string
  userId: string
  planVersionId: string
  provider: string
  providerCheckoutId: string | null
  priceAmount: number | null
  priceCurrency: string
  status: string
  createdAt: Date
}

type StoredSubscription = {
  id: string
  userId: string
  planId: string
  planVersionId: string
  status: string
  provider: string
  providerSubscriptionId: string | null
  currentPeriodEnd: Date | null
  createdAt: Date
  planVersion: { priceAmount: number | null; priceCurrency: string }
}

type StoredSubEvent = {
  id: string
  subscriptionId: string
  type: string
  providerEventId: string | null
  createdAt: Date
}

const { store, mockDb } = vi.hoisted(() => {
  const store = {
    events: new Map<string, StoredEvent>(),
    purchases: new Map<string, StoredPurchase>(),
    attempts: new Map<string, StoredAttempt>(),
    subscriptions: new Map<string, StoredSubscription>(),
    subEvents: new Map<string, StoredSubEvent>(),
    planVersions: new Map<
      string,
      {
        id: string
        priceAmount: number | null
        priceCurrency: string
        plan: { name: string }
      }
    >(),
    users: new Map<
      string,
      { id: string; name: string | null; email: string }
    >(),
    seq: 1,
  }

  function inList<T>(value: T, cond: { in?: T[] } | T | undefined): boolean {
    if (cond === undefined) return true
    if (
      typeof cond === "object" &&
      cond !== null &&
      "in" in cond &&
      Array.isArray((cond as { in?: unknown[] }).in)
    ) {
      return ((cond as { in: T[] }).in ?? []).includes(value)
    }
    return value === (cond as T)
  }

  function inRange(date: Date, cond?: { gte?: Date; lte?: Date }): boolean {
    if (!cond) return true
    if (cond.gte && date < cond.gte) return false
    if (cond.lte && date > cond.lte) return false
    return true
  }

  function sortByCreatedAt<T extends { createdAt: Date }>(
    rows: T[],
    order?: { createdAt?: "asc" | "desc" }
  ): T[] {
    if (!order?.createdAt) return rows
    const dir = order.createdAt === "desc" ? -1 : 1
    return [...rows].sort(
      (a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime())
    )
  }

  function paged<T>(rows: T[], skip = 0, take?: number): T[] {
    return take === undefined ? rows.slice(skip) : rows.slice(skip, skip + take)
  }

  const mockDb = {
    billingEvent: {
      count: vi.fn(async ({ where }: { where?: Record<string, unknown> }) => {
        const w = (where ?? {}) as {
          kind?: { in: string[] }
          provider?: string
          userId?: { in: string[] } | string
          createdAt?: { gte?: Date; lte?: Date }
        }
        return [...store.events.values()].filter(
          (e) =>
            inList(e.kind, w.kind) &&
            inList(e.provider, w.provider) &&
            inList(e.userId, w.userId) &&
            inRange(e.createdAt, w.createdAt)
        ).length
      }),
      findMany: vi.fn(
        async ({
          where,
          orderBy,
          skip = 0,
          take,
        }: {
          where?: Record<string, unknown>
          orderBy?: { createdAt?: "asc" | "desc" }
          skip?: number
          take?: number
        }) => {
          const w = (where ?? {}) as {
            kind?: { in: string[] }
            provider?: string
            userId?: { in: string[] } | string
            createdAt?: { gte?: Date; lte?: Date }
          }
          return paged(
            sortByCreatedAt(
              [...store.events.values()].filter(
                (e) =>
                  inList(e.kind, w.kind) &&
                  inList(e.provider, w.provider) &&
                  inList(e.userId, w.userId) &&
                  inRange(e.createdAt, w.createdAt)
              ),
              orderBy
            ),
            skip,
            take
          )
        }
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return store.events.get(where.id) ?? null
      }),
    },
    subscriptionEvent: {
      findMany: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where?: { providerEventId?: { in: (string | null)[] } }
          orderBy?: { createdAt?: "asc" | "desc" }
        }) => {
          const ids = where?.providerEventId?.in ?? []
          return sortByCreatedAt(
            [...store.subEvents.values()].filter((e) =>
              ids.includes(e.providerEventId)
            ),
            orderBy
          )
        }
      ),
    },
    subscription: {
      findMany: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where?: {
            id?: { in: string[] }
            provider?: { in: string[] } | string
            userId?: { in: string[] } | string
          }
          orderBy?: { createdAt?: "asc" | "desc" }
        }) => {
          const w = where ?? {}
          return sortByCreatedAt(
            [...store.subscriptions.values()].filter(
              (s) =>
                inList(s.id, w.id) &&
                inList(s.provider, w.provider) &&
                inList(s.userId, w.userId)
            ),
            orderBy
          )
        }
      ),
      findFirst: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where?: { provider?: string; userId?: string }
          orderBy?: { createdAt?: "asc" | "desc" }
        }) => {
          const rows = sortByCreatedAt(
            [...store.subscriptions.values()].filter(
              (s) =>
                (where?.provider === undefined ||
                  s.provider === where.provider) &&
                (where?.userId === undefined || s.userId === where.userId)
            ),
            orderBy
          )
          return rows[0] ?? null
        }
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return store.subscriptions.get(where.id) ?? null
      }),
    },
    checkoutAttempt: {
      findMany: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where?: {
            provider?: { in: string[] }
            userId?: { in: string[] }
            status?: string
            createdAt?: { gte?: Date; lte?: Date }
          }
          orderBy?: { createdAt?: "asc" | "desc" }
        }) => {
          const w = where ?? {}
          return sortByCreatedAt(
            [...store.attempts.values()].filter(
              (a) =>
                inList(a.provider, w.provider) &&
                inList(a.userId, w.userId) &&
                (w.status === undefined || a.status === w.status) &&
                inRange(a.createdAt, w.createdAt)
            ),
            orderBy
          )
        }
      ),
    },
    oneTimePurchase: {
      findMany: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where?: {
            status?: { in: string[] }
            provider?: string
            userId?: { in: string[] } | string
            createdAt?: { gte?: Date; lte?: Date }
          }
          orderBy?: { createdAt?: "asc" | "desc" }
        }) => {
          const w = where ?? {}
          return sortByCreatedAt(
            [...store.purchases.values()].filter(
              (p) =>
                inList(p.status, w.status) &&
                inList(p.provider, w.provider) &&
                inList(p.userId, w.userId) &&
                inRange(p.createdAt, w.createdAt)
            ),
            orderBy
          )
        }
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return store.purchases.get(where.id) ?? null
      }),
    },
    couponRedemption: {
      // Payments display fix: the service reads the latest redemption
      // per subscription for the discount triple. This file seeds no
      // redemptions, so the faithful answer is always empty.
      findMany: vi.fn(async () => []),
    },
    planVersion: {
      // Payments display fix: the service reads plan-version prices
      // for one-time purchases (their full price). The select asks for
      // id + priceAmount only; the stored rows carry both.
      findMany: vi.fn(
        async ({ where }: { where?: { id?: { in: string[] } } }) => {
          const ids = where?.id?.in ?? []
          return [...store.planVersions.values()].filter((v) =>
            ids.includes(v.id)
          )
        }
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return store.planVersions.get(where.id) ?? null
      }),
    },
    user: {
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where?: {
            id?: { in: string[] }
            email?: { contains: string; mode?: string }
            name?: { contains: string; mode?: string }
          }
          take?: number
        }) => {
          const w = where ?? {}
          const rows = [...store.users.values()].filter((u) => {
            if (w.id && !inList(u.id, w.id)) return false
            if (
              w.email?.contains &&
              !u.email.toLowerCase().includes(w.email.contains.toLowerCase())
            )
              return false
            if (
              w.name?.contains &&
              !(u.name ?? "")
                .toLowerCase()
                .includes(w.name.contains.toLowerCase())
            )
              return false
            return true
          })
          return take === undefined ? rows : rows.slice(0, take)
        }
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return store.users.get(where.id) ?? null
      }),
    },
  }
  return { store, mockDb }
})

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/security")>()
  return { ...actual, logAudit: mockLogAudit, requireStepUp: mockRequireStepUp }
})
vi.mock("@sendcms/plans", () => ({
  activateSubscriptionFromCheckout: mockActivate,
  applyRefund: mockApplyRefund,
  cancelSubscriptionFromProvider: mockCancel,
  extendSubscriptionPeriod: mockExtend,
  markSubscriptionPastDue: mockMarkPastDue,
  syncSubscriptionFromProvider: mockSync,
}))
vi.mock("../packages/modules/billing/src/providers", () => ({
  verifyWebhookForProvider: mockVerify,
  createCheckoutForProvider: vi.fn(),
  getFreemiusPlanMapCount: () => 0,
}))
vi.mock("@/lib/require-admin-api", () => ({
  requireAdminApi: mockRequireAdminApi,
}))
vi.mock("@/lib/rate-limit", () => ({
  enforceAdminApiRateLimit: mockEnforceRateLimit,
}))
vi.mock("@sendcms/billing", () => ({
  listPayments: mockListPayments,
  getPaymentDetail: mockGetPaymentDetail,
  refundPayment: mockRefundPayment,
}))

// The service under test, imported through its source path so the
// mocked "@sendcms/billing" barrel above only affects the route
// tests.
import {
  PAYMENT_EVENT_KINDS,
  getPaymentDetail,
  getPaymentStats,
  listPayments,
  refundPayment,
} from "../packages/modules/billing/src/payments"
import {
  PaymentsQuerySchema,
  RefundPaymentSchema,
} from "../packages/modules/billing/src/validators"
import { GET as GET_PAYMENTS } from "../apps/api/app/api/v1/admin/payments/route"
import { GET as GET_PAYMENT } from "../apps/api/app/api/v1/admin/payments/[id]/route"
import { POST as POST_REFUND } from "../apps/api/app/api/v1/admin/payments/[id]/refund/route"

// ─── Seed helpers ─────────────────────────────────────────────────────

function seedUser(id: string, name: string, email: string) {
  store.users.set(id, { id, name, email })
  return id
}

function seedPlanVersion(
  id: string,
  priceAmount: number | null,
  priceCurrency = "USD",
  planName = "Pro"
) {
  store.planVersions.set(id, {
    id,
    priceAmount,
    priceCurrency,
    plan: { name: planName },
  })
  return id
}

function seedSubscription(overrides: Partial<StoredSubscription> = {}) {
  const id = overrides.id ?? `sub-${store.seq++}`
  const row: StoredSubscription = {
    id,
    userId: "user-1",
    planId: "plan-1",
    planVersionId: "pv-1",
    status: "ACTIVE",
    provider: "STRIPE",
    providerSubscriptionId: "sub_1",
    currentPeriodEnd: null,
    createdAt: at("2026-11-01T00:00:00Z"),
    planVersion: { priceAmount: 2500, priceCurrency: "USD" },
    ...overrides,
  }
  store.subscriptions.set(id, row)
  return row
}

function seedEvent(overrides: Partial<StoredEvent> = {}) {
  const id = overrides.id ?? `ev-${store.seq++}`
  const row: StoredEvent = {
    id,
    provider: "STRIPE",
    providerEventId: `evt-${store.seq}`,
    eventType: "invoice.paid",
    kind: "PAYMENT_SUCCEEDED",
    userId: "user-1",
    processedAt: at("2026-11-26T10:00:00Z"),
    createdAt: at("2026-11-26T10:00:00Z"),
    ...overrides,
  }
  store.events.set(id, row)
  return row
}

function seedPurchase(overrides: Partial<StoredPurchase> = {}) {
  const id = overrides.id ?? `otp-${store.seq++}`
  const row: StoredPurchase = {
    id,
    provider: "STRIPE",
    userId: "user-1",
    planVersionId: "pv-1",
    subscriptionId: null,
    providerReference: "pi_1",
    checkoutId: "cs_1",
    priceAmount: 1900,
    priceCurrency: "USD",
    status: "ACTIVE",
    accessStart: at("2026-11-26T10:00:00Z"),
    accessEnd: at("2027-11-26T10:00:00Z"),
    createdAt: at("2026-11-26T10:00:00Z"),
    ...overrides,
  }
  store.purchases.set(id, row)
  return row
}

function seedAttempt(overrides: Partial<StoredAttempt> = {}) {
  const id = overrides.id ?? `att-${store.seq++}`
  const row: StoredAttempt = {
    id,
    attemptId: `attempt-${store.seq}`,
    userId: "user-1",
    planVersionId: "pv-1",
    provider: "STRIPE",
    providerCheckoutId: "cs_1",
    priceAmount: 4900,
    priceCurrency: "USD",
    status: "COMPLETED",
    createdAt: at("2026-11-26T09:50:00Z"),
    ...overrides,
  }
  store.attempts.set(id, row)
  return row
}

function seedSubEvent(overrides: Partial<StoredSubEvent> = {}) {
  const id = overrides.id ?? `se-${store.seq++}`
  const row: StoredSubEvent = {
    id,
    subscriptionId: "sub-1",
    type: "RENEWED",
    providerEventId: null,
    createdAt: at("2026-11-26T10:00:00Z"),
    ...overrides,
  }
  store.subEvents.set(id, row)
  return row
}

const pageFilters = { page: 1, perPage: 20, tab: "all" as const }

beforeEach(() => {
  vi.clearAllMocks()
  store.events.clear()
  store.purchases.clear()
  store.attempts.clear()
  store.subscriptions.clear()
  store.subEvents.clear()
  store.planVersions.clear()
  store.users.clear()
  store.seq = 1
  mockRequireStepUp.mockResolvedValue({
    verifiedUntil: new Date("2026-11-26T13:00:00Z"),
  })
  mockApplyRefund.mockResolvedValue(null)
  seedUser("user-1", "Alice", "alice@example.com")
  seedUser("user-2", "Bob", "bob@example.com")
  seedPlanVersion("pv-1", 2500, "USD", "Pro")
})

// ─── listPayments — join correctness ───────────────────────────────────

describe("listPayments — join correctness", () => {
  it("the payment-kind set is exactly the five payment kinds", async () => {
    expect([...PAYMENT_EVENT_KINDS].sort()).toEqual(
      [
        "CHECKOUT_COMPLETED",
        "PAYMENT_SUCCEEDED",
        "PAYMENT_FAILED",
        "PAYMENT_REFUNDED",
        "UNMAPPED_PAYMENT",
      ].sort()
    )
  })

  it("a PAYMENT_SUCCEEDED event appears exactly once with the plan amount via the exact SubscriptionEvent match", async () => {
    const sub = seedSubscription({ id: "sub-1" })
    seedSubEvent({ subscriptionId: sub.id, providerEventId: "evt-1" })
    seedEvent({
      id: "ev-1",
      kind: "PAYMENT_SUCCEEDED",
      providerEventId: "evt-1",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.total).toBe(1)
    expect(page.payments).toHaveLength(1)
    const row = page.payments[0]
    expect(row.id).toBe("ev-1")
    expect(row.source).toBe("billing-event")
    expect(row.amountMinor).toBe(2500)
    expect(row.currency).toBe("USD")
    expect(row.status).toBe("SUCCEEDED")
    expect(row.subscriptionId).toBe("sub-1")
    expect(row.sourceRefs.providerEventId).toBe("evt-1")
  })

  it("a renewal resolves to the exact subscription, not the latest one, when the user has several (F1)", async () => {
    // The renewal's SubscriptionEvent points at the OLD (cheaper) plan;
    // the user has since upgraded to a NEW (pricier) plan. Rule 1 must
    // resolve the renewal to the old subscription's price — the fallback
    // (latest subscription per provider+user) would return the new price.
    // Before the F1 fix this failed: rule 1 matched on the BillingEvent
    // cuid id, which never equals a provider event id, so every renewal
    // silently fell through to the fallback.
    const oldSub = seedSubscription({
      id: "sub-old",
      planVersion: { priceAmount: 999, priceCurrency: "USD" },
      createdAt: at("2026-11-01T00:00:00Z"),
    })
    seedSubscription({
      id: "sub-new",
      planVersion: { priceAmount: 2999, priceCurrency: "USD" },
      createdAt: at("2026-11-20T00:00:00Z"),
    })
    seedSubEvent({ subscriptionId: oldSub.id, providerEventId: "evt-ren" })
    seedEvent({
      id: "ev-ren",
      kind: "PAYMENT_SUCCEEDED",
      providerEventId: "evt-ren",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.total).toBe(1)
    expect(page.payments).toHaveLength(1)
    const row = page.payments[0]
    expect(row.amountMinor).toBe(999)
    expect(row.subscriptionId).toBe("sub-old")
  })

  it("a CHECKOUT_COMPLETED event takes its amount from the closest completed attempt", async () => {
    const attempt = seedAttempt({ priceAmount: 4900 })
    const event = seedEvent({
      id: "ev-1",
      kind: "CHECKOUT_COMPLETED",
      eventType: "checkout.session.completed",
      providerEventId: "evt-co",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    expect(event.createdAt.getTime() - attempt.createdAt.getTime()).toBe(
      10 * 60 * 1000
    )
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.total).toBe(1)
    expect(page.payments[0].amountMinor).toBe(4900)
    expect(page.payments[0].sourceRefs.checkoutAttemptId).toBe(attempt.id)
    expect(page.payments[0].sourceRefs.providerCheckoutId).toBe("cs_1")
  })

  it("a CHECKOUT_COMPLETED event takes its amount from the one-time purchase, which then appears only once", async () => {
    seedEvent({
      id: "ev-1",
      kind: "CHECKOUT_COMPLETED",
      eventType: "checkout.session.completed",
      providerEventId: "evt-co",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const purchase = seedPurchase({
      createdAt: at("2026-11-26T10:02:00Z"),
      priceAmount: 1900,
    })
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.total).toBe(1)
    expect(page.payments).toHaveLength(1)
    expect(page.payments[0].id).toBe("ev-1")
    expect(page.payments[0].amountMinor).toBe(1900)
    expect(page.payments[0].sourceRefs.oneTimePurchaseId).toBe(purchase.id)
  })

  it("an unmatched UNMAPPED_PAYMENT appears with amount unknown and is never dropped", async () => {
    seedEvent({
      id: "ev-1",
      kind: "UNMAPPED_PAYMENT",
      eventType: "charge.succeeded",
      providerEventId: "evt-unmapped",
      userId: "user-2",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.total).toBe(1)
    expect(page.payments).toHaveLength(1)
    expect(page.payments[0].amountMinor).toBeNull()
    expect(page.payments[0].currency).toBeNull()
    expect(page.payments[0].status).toBe("SUCCEEDED")
    expect(page.payments[0].kind).toBe("UNMAPPED_PAYMENT")
  })

  it("a PAYMENT_FAILED event resolves its amount from the latest subscription and links it", async () => {
    const sub = seedSubscription({
      id: "sub-1",
      status: "PAST_DUE",
      planVersion: { priceAmount: 1000, priceCurrency: "USD" },
    })
    seedEvent({
      id: "ev-1",
      kind: "PAYMENT_FAILED",
      eventType: "invoice.payment_failed",
      providerEventId: "evt-fail",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.total).toBe(1)
    expect(page.payments[0].amountMinor).toBe(1000)
    expect(page.payments[0].status).toBe("FAILED")
    expect(page.payments[0].subscriptionId).toBe(sub.id)
  })

  it("a reconcile-created OneTimePurchase with no event appears once as its own row", async () => {
    const purchase = seedPurchase({
      id: "otp-1",
      priceAmount: 1900,
      createdAt: at("2026-11-20T10:00:00Z"),
    })
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.total).toBe(1)
    expect(page.payments).toHaveLength(1)
    expect(page.payments[0].id).toBe(purchase.id)
    expect(page.payments[0].source).toBe("one-time-purchase")
    expect(page.payments[0].kind).toBe("ONE_TIME_PURCHASE")
    expect(page.payments[0].amountMinor).toBe(1900)
    expect(page.payments[0].status).toBe("SUCCEEDED")
  })

  it("a purchase covered by its checkout event does not double-count", async () => {
    seedEvent({
      id: "ev-1",
      kind: "CHECKOUT_COMPLETED",
      eventType: "checkout.session.completed",
      providerEventId: "evt-co",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    seedPurchase({ createdAt: at("2026-11-26T10:00:30Z") })
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.total).toBe(1)
    expect(page.payments).toHaveLength(1)
  })

  it("the tabs split the list: succeeded / failed / refunded", async () => {
    seedSubscription({ id: "sub-1" })
    const t = "2026-11-26T10:00:00Z"
    seedEvent({ id: "ev-co", kind: "CHECKOUT_COMPLETED", createdAt: at(t) })
    seedEvent({ id: "ev-ok", kind: "PAYMENT_SUCCEEDED", createdAt: at(t) })
    seedEvent({ id: "ev-fail", kind: "PAYMENT_FAILED", createdAt: at(t) })
    seedEvent({ id: "ev-ref", kind: "PAYMENT_REFUNDED", createdAt: at(t) })
    seedEvent({ id: "ev-un", kind: "UNMAPPED_PAYMENT", createdAt: at(t) })
    seedPurchase({
      id: "otp-ref",
      status: "REFUNDED",
      createdAt: at("2026-11-20T10:00:00Z"),
    })
    const all = await listPayments(ownerActor(), pageFilters)
    expect(all.total).toBe(6)
    const succeeded = await listPayments(ownerActor(), {
      ...pageFilters,
      tab: "succeeded",
    })
    expect(succeeded.total).toBe(3)
    expect(succeeded.payments.map((p) => p.id).sort()).toEqual(
      ["ev-co", "ev-ok", "ev-un"].sort()
    )
    const failed = await listPayments(ownerActor(), {
      ...pageFilters,
      tab: "failed",
    })
    expect(failed.total).toBe(1)
    expect(failed.payments[0].id).toBe("ev-fail")
    const refunded = await listPayments(ownerActor(), {
      ...pageFilters,
      tab: "refunded",
    })
    expect(refunded.total).toBe(2)
    expect(refunded.payments.map((p) => p.id).sort()).toEqual(
      ["ev-ref", "otp-ref"].sort()
    )
  })

  it("non-payment kinds never appear in the list", async () => {
    seedEvent({ id: "ev-1", kind: "SUBSCRIPTION_CANCELED" })
    seedEvent({ id: "ev-2", kind: "IGNORED" })
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.total).toBe(0)
    expect(page.payments).toEqual([])
  })

  it("the q filter resolves a customer by email", async () => {
    seedEvent({ id: "ev-1", userId: "user-1" })
    seedEvent({ id: "ev-2", userId: "user-2" })
    const page = await listPayments(ownerActor(), {
      ...pageFilters,
      q: "alice@example.com",
    })
    expect(page.total).toBe(1)
    expect(page.payments[0].id).toBe("ev-1")
  })

  it("a q matching nobody returns an empty page without querying events", async () => {
    seedEvent({ id: "ev-1", userId: "user-1" })
    const page = await listPayments(ownerActor(), {
      ...pageFilters,
      q: "nobody@example.com",
    })
    expect(page.total).toBe(0)
    expect(page.payments).toEqual([])
    expect(mockDb.billingEvent.count).not.toHaveBeenCalled()
  })

  it("SUPPORT is refused the list (no VIEW_BILLING)", async () => {
    await expect(
      listPayments(supportActor(), pageFilters)
    ).rejects.toMatchObject({ status: 403 })
    expect(mockDb.billingEvent.count).not.toHaveBeenCalled()
  })

  it("MANAGER may read the list (VIEW_BILLING) but not refund", async () => {
    seedEvent({ id: "ev-1" })
    const page = await listPayments(managerActor(), pageFilters)
    expect(page.total).toBe(1)
    await expect(
      refundPayment(managerActor(), "ev-1", {
        fullRefund: true,
        reason: "x",
      })
    ).rejects.toMatchObject({ status: 403 })
    expect(mockApplyRefund).not.toHaveBeenCalled()
  })
})

// ─── getPaymentDetail ───────────────────────────────────────────────────

describe("getPaymentDetail — single-event read", () => {
  it("reads an event with its raw fields and linked subscription", async () => {
    const sub = seedSubscription({ id: "sub-1" })
    const event = seedEvent({
      id: "ev-1",
      kind: "PAYMENT_SUCCEEDED",
      providerEventId: "evt-1",
      eventType: "invoice.paid",
      processedAt: at("2026-11-26T10:01:00Z"),
    })
    const detail = await getPaymentDetail(ownerActor(), event.id)
    expect(detail.payment.id).toBe("ev-1")
    expect(detail.event?.providerEventId).toBe("evt-1")
    expect(detail.event?.eventType).toBe("invoice.paid")
    expect(detail.event?.processedAt).toEqual(at("2026-11-26T10:01:00Z"))
    expect(detail.subscription?.id).toBe(sub.id)
    expect(detail.subscription?.planName).toBe("Pro")
    expect(detail.purchase).toBeNull()
  })

  it("reads a standalone purchase by id with no event", async () => {
    const purchase = seedPurchase({
      id: "otp-1",
      providerReference: "pi_9",
      createdAt: at("2026-11-20T10:00:00Z"),
    })
    const detail = await getPaymentDetail(ownerActor(), purchase.id)
    expect(detail.payment.id).toBe("otp-1")
    expect(detail.payment.kind).toBe("ONE_TIME_PURCHASE")
    expect(detail.event).toBeNull()
    expect(detail.purchase?.providerReference).toBe("pi_9")
  })

  it("404s for an unknown id and for a non-payment event", async () => {
    await expect(getPaymentDetail(ownerActor(), "nope")).rejects.toMatchObject({
      status: 404,
    })
    seedEvent({ id: "ev-1", kind: "SUBSCRIPTION_UPDATED" })
    await expect(getPaymentDetail(ownerActor(), "ev-1")).rejects.toMatchObject({
      status: 404,
    })
  })
})

// ─── getPaymentStats ────────────────────────────────────────────────────

describe("getPaymentStats — 30-day stat row", () => {
  it("sums paid / failed / refunded from the join, deduping the checkout + invoice pair", async () => {
    seedSubscription({ id: "sub-1" })
    seedSubEvent({ subscriptionId: "sub-1", providerEventId: "evt-ren" })
    // One payment, two webhook events: checkout.session.completed +
    // invoice.paid for the same subscription, amount, and UTC day.
    seedEvent({
      id: "ev-co",
      kind: "CHECKOUT_COMPLETED",
      providerEventId: "evt-co",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    seedEvent({
      id: "ev-ren",
      kind: "PAYMENT_SUCCEEDED",
      providerEventId: "evt-ren",
      createdAt: at("2026-11-26T10:05:00Z"),
    })
    seedEvent({
      id: "ev-fail",
      kind: "PAYMENT_FAILED",
      providerEventId: "evt-fail",
      createdAt: at("2026-11-25T10:00:00Z"),
    })
    seedEvent({
      id: "ev-ref",
      kind: "PAYMENT_REFUNDED",
      providerEventId: "evt-ref",
      createdAt: at("2026-11-24T10:00:00Z"),
    })
    seedEvent({
      id: "ev-un",
      kind: "UNMAPPED_PAYMENT",
      providerEventId: "evt-un",
      userId: "user-2",
      createdAt: at("2026-11-23T10:00:00Z"),
    })
    seedPurchase({
      id: "otp-1",
      userId: "user-2",
      priceAmount: 1900,
      // Two days before the unmapped event: outside the ±24h
      // coverage window, so this purchase is a standalone row.
      createdAt: at("2026-11-21T10:00:00Z"),
    })
    // Outside the 30-day window: must not count.
    seedEvent({
      id: "ev-old",
      kind: "PAYMENT_SUCCEEDED",
      providerEventId: "evt-old",
      createdAt: at("2026-10-15T10:00:00Z"),
    })
    const stats = await getPaymentStats(ownerActor(), NOW)
    expect(stats.paid30d).toEqual({
      count: 3,
      amountMinor: 4400,
      currency: "USD",
      unknownCount: 1,
    })
    expect(stats.failed30d).toEqual({
      count: 1,
      amountMinor: 2500,
      currency: "USD",
      unknownCount: 0,
    })
    expect(stats.refunded30d).toEqual({
      count: 1,
      amountMinor: 2500,
      currency: "USD",
      unknownCount: 0,
    })
  })

  it("sums only the majority currency and counts unknown amounts separately", async () => {
    seedSubscription({
      id: "sub-1",
      userId: "user-1",
      planVersion: { priceAmount: 1000, priceCurrency: "USD" },
    })
    seedSubscription({
      id: "sub-2",
      userId: "user-2",
      providerSubscriptionId: "sub_2",
      planVersion: { priceAmount: 500, priceCurrency: "EUR" },
    })
    seedUser("user-3", "Carol", "carol@example.com")
    // Three USD payments, one EUR payment, one payment with no
    // matching subscription at all (unknown amount).
    seedEvent({
      id: "ev-1",
      kind: "PAYMENT_SUCCEEDED",
      userId: "user-1",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    seedEvent({
      id: "ev-2",
      kind: "PAYMENT_SUCCEEDED",
      userId: "user-1",
      createdAt: at("2026-11-25T10:00:00Z"),
    })
    seedEvent({
      id: "ev-3",
      kind: "PAYMENT_SUCCEEDED",
      userId: "user-1",
      createdAt: at("2026-11-24T10:00:00Z"),
    })
    seedEvent({
      id: "ev-4",
      kind: "PAYMENT_SUCCEEDED",
      userId: "user-2",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    seedEvent({
      id: "ev-5",
      kind: "UNMAPPED_PAYMENT",
      userId: "user-3",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const stats = await getPaymentStats(ownerActor(), NOW)
    expect(stats.paid30d.count).toBe(5)
    expect(stats.paid30d.currency).toBe("USD")
    // USD rows only: 1000 + 1000 + 1000. The EUR 500 is counted in
    // `count` but never added to a USD sum.
    expect(stats.paid30d.amountMinor).toBe(3000)
    expect(stats.paid30d.unknownCount).toBe(1)
  })
})

// ─── refundPayment — wiring + gates ─────────────────────────────────────

describe("refundPayment — wires applyRefund behind MANAGE_BILLING + step-up", () => {
  it("records a full refund: step-up consumed, applyRefund called, audit written", async () => {
    const sub = seedSubscription({
      id: "sub-1",
      providerSubscriptionId: "sub_1",
    })
    const event = seedEvent({
      id: "ev-1",
      kind: "PAYMENT_SUCCEEDED",
      providerEventId: "evt-1",
    })
    mockApplyRefund.mockResolvedValue({
      id: "sub-1",
      status: "CANCELED",
    })
    const result = await refundPayment(ownerActor(), event.id, {
      fullRefund: true,
      reason: "Duplicate charge",
    })
    expect(mockRequireStepUp).toHaveBeenCalledTimes(1)
    expect(mockApplyRefund).toHaveBeenCalledWith("STRIPE", {
      providerSubscriptionId: "sub_1",
      providerReference: null,
      fullRefund: true,
      amountMinor: null,
    })
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE",
        resourceType: "SUBSCRIPTION",
        resourceId: sub.id,
        detail: expect.objectContaining({
          event: "payment-refund-recorded",
          paymentId: event.id,
          fullRefund: true,
          reason: "Duplicate charge",
        }),
      })
    )
    expect(result.subscription).toEqual({ id: "sub-1", status: "CANCELED" })
    expect(result.payment.payment.id).toBe("ev-1")
  })

  it("refuses without step-up and never calls applyRefund", async () => {
    seedSubscription({ id: "sub-1" })
    seedEvent({ id: "ev-1", kind: "PAYMENT_SUCCEEDED" })
    mockRequireStepUp.mockRejectedValueOnce(
      new ApiError(
        "Step-up verification required. Re-enter your password to continue.",
        403
      )
    )
    await expect(
      refundPayment(ownerActor(), "ev-1", {
        fullRefund: true,
        reason: "Duplicate charge",
      })
    ).rejects.toMatchObject({ status: 403 })
    expect(mockApplyRefund).not.toHaveBeenCalled()
    expect(mockLogAudit).not.toHaveBeenCalled()
  })

  it("refuses an already-refunded purchase with 409", async () => {
    const purchase = seedPurchase({
      id: "otp-1",
      status: "REFUNDED",
      createdAt: at("2026-11-20T10:00:00Z"),
    })
    await expect(
      refundPayment(ownerActor(), purchase.id, {
        fullRefund: true,
        reason: "Duplicate charge",
      })
    ).rejects.toMatchObject({ status: 409 })
    expect(mockApplyRefund).not.toHaveBeenCalled()
    expect(mockRequireStepUp).not.toHaveBeenCalled()
  })

  it("refuses with 422 when nothing matches — and never consumes step-up", async () => {
    seedEvent({
      id: "ev-1",
      kind: "UNMAPPED_PAYMENT",
      userId: null,
    })
    await expect(
      refundPayment(ownerActor(), "ev-1", {
        fullRefund: true,
        reason: "Duplicate charge",
      })
    ).rejects.toMatchObject({ status: 422 })
    expect(mockApplyRefund).not.toHaveBeenCalled()
    expect(mockRequireStepUp).not.toHaveBeenCalled()
  })

  it("passes a partial refund amount through and keeps the subscription", async () => {
    seedSubscription({ id: "sub-1", providerSubscriptionId: "sub_1" })
    seedEvent({ id: "ev-1", kind: "PAYMENT_SUCCEEDED" })
    mockApplyRefund.mockResolvedValue({ id: "sub-1", status: "ACTIVE" })
    await refundPayment(ownerActor(), "ev-1", {
      fullRefund: false,
      amountMinor: 500,
      reason: "Goodwill partial refund",
    })
    expect(mockApplyRefund).toHaveBeenCalledWith("STRIPE", {
      providerSubscriptionId: "sub_1",
      providerReference: null,
      fullRefund: false,
      amountMinor: 500,
    })
  })
})

// ─── Validators ────────────────────────────────────────────────────────

describe("Payments validators", () => {
  it("defaults the list query to page 1, 20 per page, tab all", () => {
    expect(PaymentsQuerySchema.parse({})).toEqual({
      page: 1,
      perPage: 20,
      tab: "all",
    })
  })

  it("rejects an unknown tab", () => {
    expect(PaymentsQuerySchema.safeParse({ tab: "bogus" }).success).toBe(false)
  })

  it("requires an amount for a partial refund and a reason always", () => {
    expect(
      RefundPaymentSchema.safeParse({ fullRefund: true, reason: "x" }).success
    ).toBe(true)
    expect(
      RefundPaymentSchema.safeParse({ fullRefund: false, reason: "x" }).success
    ).toBe(false)
    expect(
      RefundPaymentSchema.safeParse({
        fullRefund: false,
        amountMinor: 500,
        reason: "x",
      }).success
    ).toBe(true)
    expect(
      RefundPaymentSchema.safeParse({ fullRefund: true, reason: "" }).success
    ).toBe(false)
  })
})

// ─── API routes (thin) ──────────────────────────────────────────────────

describe("GET /api/v1/admin/payments", () => {
  const url = "http://localhost:3001/api/v1/admin/payments?tab=failed"

  it("returns the list and gates on VIEW_BILLING", async () => {
    const res = await GET_PAYMENTS(new NextRequest(url))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      payments: [],
      total: 0,
      page: 1,
      perPage: 20,
      totalPages: 1,
    })
    expect(mockRequireAdminApi).toHaveBeenCalledWith("VIEW_BILLING")
    expect(mockListPayments).toHaveBeenCalledWith(mockSession, {
      page: 1,
      perPage: 20,
      tab: "failed",
    })
  })

  it("returns 422 for an unknown tab without calling the service", async () => {
    const res = await GET_PAYMENTS(
      new NextRequest("http://localhost:3001/api/v1/admin/payments?tab=bogus")
    )
    expect(res.status).toBe(422)
    expect(mockListPayments).not.toHaveBeenCalled()
  })

  it("returns 403 when the actor lacks VIEW_BILLING", async () => {
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Forbidden", 403))
    const res = await GET_PAYMENTS(new NextRequest(url))
    expect(res.status).toBe(403)
    expect(mockListPayments).not.toHaveBeenCalled()
  })

  it("returns the rate-limit response instead of the list", async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(
      new NextResponse(null, { status: 429 })
    )
    const res = await GET_PAYMENTS(new NextRequest(url))
    expect(res.status).toBe(429)
    expect(mockListPayments).not.toHaveBeenCalled()
  })
})

describe("GET /api/v1/admin/payments/[id]", () => {
  const url = "http://localhost:3001/api/v1/admin/payments/ev-1"

  it("returns the detail and gates on VIEW_BILLING", async () => {
    const res = await GET_PAYMENT(new NextRequest(url), {
      params: Promise.resolve({ id: "ev-1" }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ payment: { id: "ev-1" } })
    expect(mockRequireAdminApi).toHaveBeenCalledWith("VIEW_BILLING")
    expect(mockGetPaymentDetail).toHaveBeenCalledWith(mockSession, "ev-1")
  })

  it("returns 403 when the actor lacks VIEW_BILLING", async () => {
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Forbidden", 403))
    const res = await GET_PAYMENT(new NextRequest(url), {
      params: Promise.resolve({ id: "ev-1" }),
    })
    expect(res.status).toBe(403)
    expect(mockGetPaymentDetail).not.toHaveBeenCalled()
  })
})

describe("POST /api/v1/admin/payments/[id]/refund", () => {
  const url = "http://localhost:3001/api/v1/admin/payments/ev-1/refund"

  function post(body: unknown) {
    return new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  }

  it("records the refund and gates on MANAGE_BILLING", async () => {
    const res = await POST_REFUND(
      post({ fullRefund: true, reason: "Duplicate charge" }),
      { params: Promise.resolve({ id: "ev-1" }) }
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      payment: { id: "ev-1" },
      subscription: null,
    })
    expect(mockRequireAdminApi).toHaveBeenCalledWith("MANAGE_BILLING")
    expect(mockRefundPayment).toHaveBeenCalledWith(mockSession, "ev-1", {
      fullRefund: true,
      reason: "Duplicate charge",
    })
  })

  it("returns 422 without a reason and never calls the service", async () => {
    const res = await POST_REFUND(post({ fullRefund: true }), {
      params: Promise.resolve({ id: "ev-1" }),
    })
    expect(res.status).toBe(422)
    expect(mockRefundPayment).not.toHaveBeenCalled()
  })

  it("returns 403 when the actor lacks MANAGE_BILLING", async () => {
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Forbidden", 403))
    const res = await POST_REFUND(
      post({ fullRefund: true, reason: "Duplicate charge" }),
      { params: Promise.resolve({ id: "ev-1" }) }
    )
    expect(res.status).toBe(403)
    expect(mockRefundPayment).not.toHaveBeenCalled()
  })
})

// ─── Capability gate (coordinator-owned) ───────────────────────────────

describe("Payments — capability gate (Q11, plan §3.5)", () => {
  it("is gated on VIEW_BILLING in PLATFORM_ROUTE_CAPABILITY", () => {
    // Coordinator-owned map entry — see the file header. This test
    // fails until the coordinator adds
    // "/admin/payments": "VIEW_BILLING" to
    // packages/permissions/src/platform.ts.
    expect(PLATFORM_ROUTE_CAPABILITY["/admin/payments"]).toBe("VIEW_BILLING")
  })

  it("excludes SUPPORT from view (same as /admin/billing)", () => {
    expect(adminCan("SUPPORT", "VIEW_BILLING")).toBe(false)
    expect(adminCan("MANAGER", "VIEW_BILLING")).toBe(true)
    expect(adminCan("SUPER_ADMIN", "VIEW_BILLING")).toBe(true)
    expect(adminCan("PLATFORM_USER", "VIEW_BILLING")).toBe(false)
  })

  it("restricts refunds to MANAGE_BILLING (owner + SUPER_ADMIN)", () => {
    expect(adminCan("MANAGER", "MANAGE_BILLING")).toBe(false)
    expect(adminCan("SUPER_ADMIN", "MANAGE_BILLING")).toBe(true)
    expect(adminCan("SUPPORT", "MANAGE_BILLING")).toBe(false)
  })
})

// ─── Page wiring ────────────────────────────────────────────────────────

describe("Payments — page wiring", () => {
  const page = () => read("apps/admin/app/admin/payments/page.tsx")

  it("server-fetches stats + list and renders the table with the page locale", () => {
    const src = page()
    expect(src).toContain("getPaymentStats")
    expect(src).toContain("listPayments")
    expect(src).toContain("PageHeader")
    expect(src).toContain("StatCard")
    expect(src).toContain("PaymentsTable")
    expect(src).toContain('getTranslator(locale, "payments")')
    expect(src).toContain("initialData={initialData}")
    expect(src).toContain('adminCan(actorRole, "MANAGE_BILLING")')
    expect(src).toContain("canRefund={canRefund}")
  })

  it("has three stat cards (paid / failed / refunded, 30 days)", () => {
    const src = page()
    expect(src).toContain('t("statPaid30d")')
    expect(src).toContain('t("statFailed30d")')
    expect(src).toContain('t("statRefunded30d")')
    expect(src).toContain("formatAmountMinor")
  })

  it("adds no PageHeader action slot (no single primary action — do not invent one)", () => {
    expect(page()).not.toContain("action={")
  })

  it("stays in the layered flow: no db import, no revalidatePath", () => {
    const src = page()
    expect(src).not.toContain("@sendcms/database")
    expect(src).not.toContain("revalidatePath")
  })

  it("has exactly the route files (page + loading + error)", () => {
    expect(
      readdirSync(path.join(root, "apps/admin/app/admin/payments")).sort()
    ).toEqual(["error.tsx", "loading.tsx", "page.tsx"])
  })
})

describe("Payments — table wiring", () => {
  const table = () => read("apps/admin/components/admin/payments-table.tsx")

  it("uses the shared Tabs / Table / DropdownMenu / Dialogs with tab semantics", () => {
    const src = table()
    // Prettier splits the import across lines, so assert the
    // identifiers, not the single-line import string.
    for (const name of ["Tabs", "TabsContent", "TabsList", "TabsTrigger"]) {
      expect(src, name).toContain(name)
    }
    expect(src).toContain('value="all"')
    expect(src).toContain('value="succeeded"')
    expect(src).toContain('value="failed"')
    expect(src).toContain('value="refunded"')
    expect(src).toContain("DropdownMenu")
    expect(src).toContain("StepUpDialog")
    expect(src).toContain("usePaymentDetail")
    expect(src).toContain("useRefundPayment")
  })

  it("shows the raw-event link for unknown-amount rows and links failed rows to the subscription", () => {
    const src = table()
    expect(src).toContain('t("viewRawEvent")')
    expect(src).toContain("/admin/billing")
    expect(src).toContain("/admin/all-users/${row.userId}")
    expect(src).toContain('t("viewSubscription")')
  })

  it("keeps the bundle boundary: no server-only imports in the client table", () => {
    const src = table()
    expect(src).not.toContain("@sendcms/database")
    expect(src).not.toContain('from "@sendcms/billing"')
    expect(src).not.toContain("requireStepUp")
    // The header comment NAMES applyRefund (to say the table never
    // calls it); assert there is no call or import of it.
    expect(src).not.toContain("applyRefund(")
    expect(src).not.toContain('from "@sendcms/plans"')
    expect(src).toContain('from "@sendcms/billing/queries"')
    expect(src).toContain("formatAmountMinor")
  })
})

describe("Payments — routes stay thin", () => {
  it("the three routes gate, validate, and delegate — nothing else", () => {
    const list = read("apps/api/app/api/v1/admin/payments/route.ts")
    expect(list).toContain('requireAdminApi("VIEW_BILLING")')
    expect(list).toContain("PaymentsQuerySchema")
    expect(list).toContain("listPayments")
    expect(list).toContain("handleApiError")
    expect(list).not.toContain("@sendcms/database")
    expect(list).not.toContain("revalidatePath")
    const detail = read("apps/api/app/api/v1/admin/payments/[id]/route.ts")
    expect(detail).toContain('requireAdminApi("VIEW_BILLING")')
    expect(detail).toContain("getPaymentDetail")
    expect(detail).not.toContain("@sendcms/database")
    const refund = read(
      "apps/api/app/api/v1/admin/payments/[id]/refund/route.ts"
    )
    expect(refund).toContain('requireAdminApi("MANAGE_BILLING")')
    expect(refund).toContain("RefundPaymentSchema")
    expect(refund).toContain("refundPayment")
    // Step-up lives in the service, never in the route. The refund
    // route's header comment NAMES applyRefund (to say the route
    // never calls it); assert there is no call of it.
    expect(refund).not.toContain("requireStepUp")
    expect(refund).not.toContain("applyRefund(")
    expect(refund).not.toContain("@sendcms/database")
    expect(refund).not.toContain("revalidatePath")
  })
})

// ─── i18n ───────────────────────────────────────────────────────────────

describe("Payments — i18n", () => {
  it("has the payments nav key in en + ur (the sidebar label)", () => {
    expect(
      readJson("packages/i18n/locales/en/admin/navigation.json").payments
    ).toBe("Payments")
    expect(
      readJson("packages/i18n/locales/ur/admin/navigation.json").payments
    ).toBe("ادائیگیاں")
  })

  it("has the payments domain file in en + ur with matching keys", () => {
    const en = readJson("packages/i18n/locales/en/admin/payments.json")
    const ur = readJson("packages/i18n/locales/ur/admin/payments.json")
    expect(Object.keys(en).sort()).toEqual(Object.keys(ur).sort())
    for (const key of [
      "title",
      "description",
      "tabAll",
      "tabSucceeded",
      "tabFailed",
      "tabRefunded",
      "statPaid30d",
      "statFailed30d",
      "statRefunded30d",
      "colAmount",
      "colCustomer",
      "colProvider",
      "colStatus",
      "amountUnknown",
      "view",
      "viewRawEvent",
      "viewSubscription",
      "refundTitle",
      "refundNote",
      "refundFull",
      "refundPartial",
      "detailTitle",
      "detailLoadError",
    ]) {
      expect(en[key], `en.${key}`).toBeDefined()
      expect(ur[key], `ur.${key}`).toBeDefined()
    }
    expect(en.title).toBe("Payments")
  })

  it("registers the domain for server + client translation loading", () => {
    // packages/i18n/src/load.ts is coordinator-owned — see the file
    // header. This assertion fails until the coordinator adds
    // "payments" to ADMIN_DOMAINS.
    expect(read("packages/i18n/src/load.ts")).toContain('"payments"')
    expect(read("apps/admin/lib/i18n.ts")).toContain('"payments"')
  })

  it("uses the locale-aware format helpers — formatCurrency already has callers", () => {
    // Wave 7 helpers are NOT first-called here: formatCurrency is
    // already used by plan-format.ts and ai-format.ts, so this page
    // reuses them (via formatAmountMinor) instead of minting new ones.
    expect(read("apps/admin/components/admin/plan-format.ts")).toContain(
      "formatCurrency"
    )
    expect(read("apps/admin/components/admin/ai-format.ts")).toContain(
      "formatCurrency"
    )
    expect(read("apps/admin/components/admin/plan-format.ts")).toContain(
      "formatAmountMinor"
    )
  })
})

// ─── Consolidation-owned wiring (sidebar + permissions test) ────────────

describe("Payments — consolidation-owned wiring", () => {
  it("has the sidebar item `payments` in Platform next to `billing`", () => {
    // Coordinator-owned — see the file header. Fails until the
    // coordinator adds `{ label: t("payments"), href:
    // "/admin/payments", icon: RiWalletLine }` after the billing item
    // in apps/admin/components/admin/app-sidebar.tsx.
    expect(read("apps/admin/components/admin/app-sidebar.tsx")).toContain(
      'href: "/admin/payments"'
    )
  })

  it("pins the map entry in tests/permissions.test.ts", () => {
    // Coordinator-owned — see the file header. Fails until the
    // coordinator adds `"/admin/payments": "VIEW_BILLING"` to the
    // expected map in tests/permissions.test.ts.
    expect(read("tests/permissions.test.ts")).toContain(
      '"/admin/payments": "VIEW_BILLING"'
    )
  })
})

// ─── Loading + error boundaries ─────────────────────────────────────────

describe("Payments — loading + error boundaries", () => {
  it("adds loading.tsx + error.tsx for the new route (SRC-111 pattern)", () => {
    expect(
      existsSync(path.join(root, "apps/admin/app/admin/payments/loading.tsx"))
    ).toBe(true)
    expect(
      existsSync(path.join(root, "apps/admin/app/admin/payments/error.tsx"))
    ).toBe(true)
    expect(read("apps/admin/app/admin/payments/loading.tsx")).toContain(
      "Skeleton"
    )
    const error = read("apps/admin/app/admin/payments/error.tsx")
    expect(error).toContain('"use client"')
    expect(error).toContain("createLogger")
    // SEC-107: generic message, never the error's own message.
    expect(error).not.toContain("error.message")
  })
})
