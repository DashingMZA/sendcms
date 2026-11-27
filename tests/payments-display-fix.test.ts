// Payments display fix — a discounted payment shows BOTH the full
// price and what the user actually paid on /admin/payments.
// - Subscription rows: full = PlanVersion price; the discount is the
//   subscription's CouponRedemption (grant-time, minor units actually
//   discounted); paid = full - discount.
// - One-time purchase rows: the purchase stores the discounted amount;
//   full = its PlanVersion's price.
// - Checkout-attempt rows: priceAmount is the discounted amount
//   actually charged; the discount is the attempt's discountAmountMinor.
// No test hits the real DB, a real provider, or the network: the
// service is tested through the same mocked-Prisma pattern as
// tests/seven-pages-phase-b-worker-b.test.ts.
//
// TIME: no test asserts a locale-rendered clock time. All createdAt
// values are pinned UTC instants; the ±1h / 24h match windows are
// compared on Date.getTime(), so no timeZone pinning is needed.
import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
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
const at = (iso: string) => new Date(iso)
const pageFilters = { page: 1, perPage: 20, tab: "all" as const }

// ─── Mocks ────────────────────────────────────────────────────────────

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
  couponCode: string | null
  discountAmountMinor: number | null
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

type StoredRedemption = {
  id: string
  couponId: string
  userId: string
  subscriptionId: string | null
  checkoutAttemptId: string | null
  discountAmount: number
  currency: string
  createdAt: Date
}

const { store, mockDb } = vi.hoisted(() => {
  const store = {
    events: new Map<string, StoredEvent>(),
    purchases: new Map<string, StoredPurchase>(),
    attempts: new Map<string, StoredAttempt>(),
    subscriptions: new Map<string, StoredSubscription>(),
    subEvents: new Map<string, StoredSubEvent>(),
    redemptions: new Map<string, StoredRedemption>(),
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
            OR?: Array<Record<string, unknown>>
          }
          // The refunded-tab OR shape is not used by these tests;
          // the list path only passes the flat shape.
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
      findMany: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where?: { subscriptionId?: { in: (string | null)[] } }
          orderBy?: { createdAt?: "asc" | "desc" }
        }) => {
          const ids = where?.subscriptionId?.in ?? []
          return sortByCreatedAt(
            [...store.redemptions.values()].filter((r) =>
              ids.includes(r.subscriptionId)
            ),
            orderBy
          )
        }
      ),
    },
    planVersion: {
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
  return {
    ...actual,
    logAudit: vi.fn(async () => undefined),
    requireStepUp: vi.fn(async () => ({
      verifiedUntil: new Date("2026-11-26T13:00:00Z"),
    })),
  }
})
vi.mock("@sendcms/plans", () => ({
  applyRefund: vi.fn(async () => null),
}))

import {
  getPaymentDetail,
  listPayments,
} from "../packages/modules/billing/src/payments"

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

function seedSubEvent(overrides: Partial<StoredSubEvent> = {}) {
  const id = overrides.id ?? `se-${store.seq++}`
  const row: StoredSubEvent = {
    id,
    subscriptionId: "sub-1",
    type: "invoice.paid",
    providerEventId: "evt-1",
    createdAt: at("2026-11-26T10:00:00Z"),
    ...overrides,
  }
  store.subEvents.set(id, row)
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
    couponCode: null,
    discountAmountMinor: null,
    status: "COMPLETED",
    createdAt: at("2026-11-26T09:50:00Z"),
    ...overrides,
  }
  store.attempts.set(id, row)
  return row
}

function seedRedemption(overrides: Partial<StoredRedemption> = {}) {
  const id = overrides.id ?? `red-${store.seq++}`
  const row: StoredRedemption = {
    id,
    couponId: "cpn-1",
    userId: "user-1",
    subscriptionId: "sub-1",
    checkoutAttemptId: null,
    discountAmount: 500,
    currency: "USD",
    createdAt: at("2026-11-26T09:00:00Z"),
    ...overrides,
  }
  store.redemptions.set(id, row)
  return row
}

beforeEach(() => {
  vi.clearAllMocks()
  store.events.clear()
  store.purchases.clear()
  store.attempts.clear()
  store.subscriptions.clear()
  store.subEvents.clear()
  store.redemptions.clear()
  store.planVersions.clear()
  store.users.clear()
  seedUser("user-1", "Alice", "alice@example.com")
  seedPlanVersion("pv-1", 2500, "USD", "Pro")
})

// ─── Subscription rows ────────────────────────────────────────────────

describe("payments display fix — subscription rows", () => {
  it("a discounted subscription shows the full price AND what the user paid", async () => {
    const sub = seedSubscription({ id: "sub-1" })
    seedSubEvent({ subscriptionId: sub.id, providerEventId: "evt-1" })
    seedRedemption({ subscriptionId: sub.id, discountAmount: 500 })
    seedEvent({
      id: "ev-1",
      kind: "PAYMENT_SUCCEEDED",
      providerEventId: "evt-1",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.payments).toHaveLength(1)
    const row = page.payments[0]
    expect(row.amountMinor).toBe(2500)
    expect(row.fullAmountMinor).toBe(2500)
    expect(row.discountAmountMinor).toBe(500)
    expect(row.paidAmountMinor).toBe(2000)
  })

  it("a subscription without a coupon shows no discount and paid equals the full price", async () => {
    const sub = seedSubscription({ id: "sub-1" })
    seedSubEvent({ subscriptionId: sub.id, providerEventId: "evt-1" })
    seedEvent({
      id: "ev-1",
      kind: "PAYMENT_SUCCEEDED",
      providerEventId: "evt-1",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.payments).toHaveLength(1)
    const row = page.payments[0]
    expect(row.amountMinor).toBe(2500)
    expect(row.fullAmountMinor).toBe(2500)
    expect(row.discountAmountMinor).toBeNull()
    expect(row.paidAmountMinor).toBe(2500)
  })

  it("a redemption in another currency than the plan price is ignored — amounts are never subtracted across currencies", async () => {
    const sub = seedSubscription({ id: "sub-1" })
    seedSubEvent({ subscriptionId: sub.id, providerEventId: "evt-1" })
    seedRedemption({
      subscriptionId: sub.id,
      discountAmount: 500,
      currency: "EUR",
    })
    seedEvent({
      id: "ev-1",
      kind: "PAYMENT_SUCCEEDED",
      providerEventId: "evt-1",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.payments).toHaveLength(1)
    const row = page.payments[0]
    expect(row.discountAmountMinor).toBeNull()
    expect(row.paidAmountMinor).toBe(2500)
  })

  it("the fallback (latest subscription) row also carries the discount", async () => {
    const sub = seedSubscription({ id: "sub-1" })
    seedRedemption({ subscriptionId: sub.id, discountAmount: 500 })
    // No SubscriptionEvent: the renewal falls through to the latest
    // subscription per provider+user (rule 4).
    seedEvent({
      id: "ev-1",
      kind: "PAYMENT_SUCCEEDED",
      providerEventId: "evt-no-sub-event",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.payments).toHaveLength(1)
    const row = page.payments[0]
    expect(row.subscriptionId).toBe("sub-1")
    expect(row.amountMinor).toBe(2500)
    expect(row.discountAmountMinor).toBe(500)
    expect(row.paidAmountMinor).toBe(2000)
  })
})

// ─── One-time purchase rows ───────────────────────────────────────────

describe("payments display fix — one-time purchase rows", () => {
  it("a discounted one-time purchase shows the plan price as full and the recorded amount as paid", async () => {
    seedPlanVersion("pv-otp", 5000, "USD", "Lifetime")
    seedPurchase({
      planVersionId: "pv-otp",
      priceAmount: 4500,
      priceCurrency: "USD",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.payments).toHaveLength(1)
    const row = page.payments[0]
    expect(row.kind).toBe("ONE_TIME_PURCHASE")
    expect(row.amountMinor).toBe(4500)
    expect(row.fullAmountMinor).toBe(5000)
    expect(row.discountAmountMinor).toBe(500)
    expect(row.paidAmountMinor).toBe(4500)
  })

  it("a one-time purchase at full price shows no discount", async () => {
    seedPurchase({
      planVersionId: "pv-1",
      priceAmount: 2500,
      priceCurrency: "USD",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.payments).toHaveLength(1)
    const row = page.payments[0]
    expect(row.fullAmountMinor).toBe(2500)
    expect(row.discountAmountMinor).toBeNull()
    expect(row.paidAmountMinor).toBe(2500)
  })

  it("the payment detail for a purchase id carries the same full + paid amounts", async () => {
    seedPlanVersion("pv-otp", 5000, "USD", "Lifetime")
    const purchase = seedPurchase({
      planVersionId: "pv-otp",
      priceAmount: 4500,
      priceCurrency: "USD",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const detail = await getPaymentDetail(ownerActor(), purchase.id)
    expect(detail.payment.kind).toBe("ONE_TIME_PURCHASE")
    expect(detail.payment.fullAmountMinor).toBe(5000)
    expect(detail.payment.discountAmountMinor).toBe(500)
    expect(detail.payment.paidAmountMinor).toBe(4500)
  })
})

// ─── Checkout-attempt rows ────────────────────────────────────────────

describe("payments display fix — checkout-attempt rows", () => {
  it("an attempt with a coupon shows paid + discount on top of the charged amount", async () => {
    seedAttempt({
      priceAmount: 1800,
      couponCode: "SAVE20",
      discountAmountMinor: 200,
      createdAt: at("2026-11-26T09:50:00Z"),
    })
    seedEvent({
      id: "ev-1",
      kind: "CHECKOUT_COMPLETED",
      eventType: "checkout.session.completed",
      providerEventId: "evt-co",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.payments).toHaveLength(1)
    const row = page.payments[0]
    expect(row.amountMinor).toBe(1800)
    expect(row.fullAmountMinor).toBe(2000)
    expect(row.discountAmountMinor).toBe(200)
    expect(row.paidAmountMinor).toBe(1800)
  })
})

// ─── Unknown amounts ──────────────────────────────────────────────────

describe("payments display fix — unknown amounts", () => {
  it("an unmatched event keeps all three amounts unknown", async () => {
    seedEvent({
      id: "ev-1",
      kind: "UNMAPPED_PAYMENT",
      providerEventId: "evt-unknown",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const page = await listPayments(ownerActor(), pageFilters)
    expect(page.payments).toHaveLength(1)
    const row = page.payments[0]
    expect(row.amountMinor).toBeNull()
    expect(row.fullAmountMinor).toBeNull()
    expect(row.discountAmountMinor).toBeNull()
    expect(row.paidAmountMinor).toBeNull()
  })
})

// ─── UI wiring (static) ───────────────────────────────────────────────

describe("payments display fix — UI wiring", () => {
  it("the payments table renders the full price and the paid amount when a discount applies", () => {
    const table = read("apps/admin/components/admin/payments-table.tsx")
    expect(table).toContain("discountAmountMinor")
    expect(table).toContain("paidAmountMinor")
    expect(table).toContain("fullAmountMinor")
    expect(table).toContain("paidAmount")
  })

  it("the paid label exists in both locales", () => {
    expect(
      readJson("packages/i18n/locales/en/admin/payments.json").paidAmount
    ).toBe("Paid")
    expect(
      readJson("packages/i18n/locales/ur/admin/payments.json").paidAmount
    ).toBe("ادا شدہ")
  })
})
