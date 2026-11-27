// F2 (Phase 16, Wave 11, Stream C) — the Refunded tab stays empty
// after a recorded refund.
//
// Root cause: `applyRefund` writes NO `PAYMENT_REFUNDED` BillingEvent.
// A full refund cancels the subscription (a CANCELED SubscriptionEvent
// whose reason starts "Refunded in full…") and flips the linked
// one-time purchase to REFUNDED; a partial refund keeps the
// subscription and writes a REFUNDED SubscriptionEvent. The tab
// matched on the BillingEvent kind alone, so neither surfaced. The fix
// (packages/modules/billing/src/payments.ts) matches the tab — and the
// 30-day refunded stats bucket, and the payment detail — on the linked
// subscription/purchase refund state as well. `applyRefund` itself is
// untouched.
//
// No test hits the real DB, a real provider, or the network: the
// mocked-Prisma store below mirrors tests/seven-pages-phase-b-worker-b.test.ts
// (same in-memory pattern), extended with the queries the refund
// linkage needs (SubscriptionEvent OR-by-type/reason, purchase status,
// subscription owners). The `applyRefund` fake performs the same store
// mutations the real one performs (cancel + refund-cancel event for a
// full refund; REFUNDED timeline event for a partial one), so the
// "record a refund, assert the tab shows it" test drives the real
// `refundPayment` service end to end at the service level.
//
// TIME: no test asserts a locale-rendered clock time. `getPaymentStats`
// takes an explicit `now`; day buckets use toISOString (UTC).
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AdminSession } from "@sendcms/auth"
import {
  getPaymentDetail,
  getPaymentStats,
  listPayments,
  refundPayment,
} from "../packages/modules/billing/src/payments"

const NOW = new Date("2026-11-26T12:00:00Z")
const at = (iso: string) => new Date(iso)

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

// ─── Mocks ────────────────────────────────────────────────────────────

const mockLogAudit = vi.hoisted(() => vi.fn(async () => undefined))
const mockRequireStepUp = vi.hoisted(() =>
  vi.fn(async () => ({ verifiedUntil: new Date("2026-11-26T13:00:00Z") }))
)
// The applyRefund fake (set in beforeEach): performs the real
// function's store effects — full refund cancels the subscription +
// writes the refund-cancel event + flips linked purchases; partial
// refund keeps the subscription + writes a REFUNDED timeline event.
const mockApplyRefund = vi.hoisted(() => vi.fn())

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
  status: "ACTIVE" | "REFUNDED" | "EXPIRED"
  accessStart: Date
  accessEnd: Date
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
  reason: string | null
  providerEventId: string | null
  createdAt: Date
}

type StoredAttempt = {
  id: string
  provider: string
  userId: string
  priceAmount: number | null
  priceCurrency: string
  status: string
  providerCheckoutId: string
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

  // Shared where-matching for the event / purchase / subscription
  // list queries: kind / provider / userId / status / createdAt, plus
  // an OR array of branch wheres (the refunded tab's candidate query).
  function matchesWhere(
    row: Record<string, unknown>,
    where?: Record<string, unknown>
  ): boolean {
    if (!where) return true
    if (Array.isArray(where.OR)) {
      return (where.OR as Record<string, unknown>[]).some((branch) =>
        matchesWhere(row, branch)
      )
    }
    for (const [key, cond] of Object.entries(where)) {
      if (key === "OR") continue
      if (key === "createdAt") {
        if (!inRange(row.createdAt as Date, cond as { gte?: Date; lte?: Date }))
          return false
        continue
      }
      if (!inList(row[key], cond as { in?: unknown[] } | unknown)) return false
    }
    return true
  }

  const mockDb = {
    billingEvent: {
      count: vi.fn(async ({ where }: { where?: Record<string, unknown> }) => {
        return [...store.events.values()].filter((e) =>
          matchesWhere(e as unknown as Record<string, unknown>, where)
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
          return paged(
            sortByCreatedAt(
              [...store.events.values()].filter((e) =>
                matchesWhere(e as unknown as Record<string, unknown>, where)
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
          where?: {
            providerEventId?: { in: (string | null)[] }
            subscriptionId?: string
            type?: { in: string[] } | string
            OR?: Record<string, unknown>[]
          }
          orderBy?: { createdAt?: "asc" | "desc" }
        }) => {
          const rows = [...store.subEvents.values()].filter((e) => {
            if (where?.providerEventId) {
              if (!inList(e.providerEventId, where.providerEventId))
                return false
            }
            if (
              where?.subscriptionId !== undefined &&
              e.subscriptionId !== where.subscriptionId
            ) {
              return false
            }
            if (where?.type !== undefined && !inList(e.type, where.type)) {
              return false
            }
            if (Array.isArray(where?.OR)) {
              // F2 linkage query: { type: "REFUNDED" } OR
              // { type: "CANCELED", reason contains "refunded in full" }.
              const hit = (where.OR as Record<string, unknown>[]).some(
                (branch) => {
                  if (
                    branch.type !== undefined &&
                    e.type !== (branch.type as string)
                  ) {
                    return false
                  }
                  const reason = branch.reason as
                    { contains?: string; mode?: string } | undefined
                  if (reason?.contains !== undefined) {
                    const needle = reason.contains.toLowerCase()
                    if (!(e.reason ?? "").toLowerCase().includes(needle)) {
                      return false
                    }
                  }
                  return true
                }
              )
              if (!hit) return false
            }
            return true
          })
          return sortByCreatedAt(rows, orderBy)
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
    planVersion: {
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
  activateSubscriptionFromCheckout: vi.fn(async () => null),
  applyRefund: mockApplyRefund,
  cancelSubscriptionFromProvider: vi.fn(async () => null),
  extendSubscriptionPeriod: vi.fn(async () => null),
  markSubscriptionPastDue: vi.fn(async () => null),
  syncSubscriptionFromProvider: vi.fn(async () => null),
}))
vi.mock("../packages/modules/billing/src/providers", () => ({
  verifyWebhookForProvider: vi.fn(),
}))

// The service under test imports the real service through its relative
// source path (the @sendcms/billing barrel is NOT mocked here).
import { PaymentsQuerySchema } from "../packages/modules/billing/src/validators"

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

function seedSubEvent(overrides: Partial<StoredSubEvent> = {}) {
  const id = overrides.id ?? `se-${store.seq++}`
  const row: StoredSubEvent = {
    id,
    subscriptionId: "sub-1",
    type: "RENEWED",
    reason: null,
    providerEventId: null,
    createdAt: at("2026-11-26T10:00:00Z"),
    ...overrides,
  }
  store.subEvents.set(id, row)
  return row
}

function filtersFor(tab: "all" | "succeeded" | "failed" | "refunded") {
  return PaymentsQuerySchema.parse({ page: 1, perPage: 20, tab })
}

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
  // applyRefund fake: the real function's store effects, so a refund
  // recorded through refundPayment leaves exactly the rows the real
  // applyRefund leaves (see the file header).
  mockApplyRefund.mockImplementation(
    async (
      provider: string,
      input: {
        providerSubscriptionId: string | null
        providerReference?: string | null
        fullRefund: boolean
        amountMinor?: number | null
      }
    ) => {
      if (input.providerSubscriptionId) {
        const sub = [...store.subscriptions.values()].find(
          (s) =>
            s.provider === provider &&
            s.providerSubscriptionId === input.providerSubscriptionId
        )
        if (sub) {
          if (input.fullRefund) {
            sub.status = "CANCELED"
            seedSubEvent({
              subscriptionId: sub.id,
              type: "CANCELED",
              reason: `Refunded in full by ${provider.toLowerCase()} (${input.amountMinor ?? ""})`,
              createdAt: NOW,
            })
            for (const p of store.purchases.values()) {
              if (p.subscriptionId === sub.id && p.status === "ACTIVE") {
                p.status = "REFUNDED"
              }
            }
          } else {
            seedSubEvent({
              subscriptionId: sub.id,
              type: "REFUNDED",
              reason: `Partial refund by ${provider.toLowerCase()} — subscription kept`,
              createdAt: NOW,
            })
          }
          return { id: sub.id, status: sub.status }
        }
      }
      if (input.providerReference) {
        const purchase = [...store.purchases.values()].find(
          (p) =>
            p.provider === provider &&
            p.providerReference === input.providerReference &&
            p.status === "ACTIVE"
        )
        if (purchase) {
          purchase.status = "REFUNDED"
          return null
        }
      }
      return null
    }
  )
  seedUser("user-1", "Alice", "alice@example.com")
  seedUser("user-2", "Bob", "bob@example.com")
  seedPlanVersion("pv-1", 2500, "USD", "Pro")
})

// ─── F2 regression tests ───────────────────────────────────────────────

describe("F2 — the Refunded tab after a recorded refund", () => {
  it("a full refund recorded through refundPayment shows the payment in the Refunded tab", async () => {
    const sub = seedSubscription({ id: "sub-1" })
    seedSubEvent({ subscriptionId: sub.id, providerEventId: "evt-1" })
    const event = seedEvent({
      id: "ev-1",
      kind: "PAYMENT_SUCCEEDED",
      providerEventId: "evt-1",
      createdAt: at("2026-11-26T10:00:00Z"),
    })

    // Before the refund the tab is empty (the pre-fix behaviour was
    // that it stayed empty forever — no PAYMENT_REFUNDED event exists).
    const before = await listPayments(ownerActor(), filtersFor("refunded"))
    expect(before.total).toBe(0)
    expect(before.payments).toHaveLength(0)

    // Record the refund (full): step-up consumed, applyRefund cancels
    // the subscription. applyRefund writes NO BillingEvent.
    const result = await refundPayment(ownerActor(), event.id, {
      fullRefund: true,
      reason: "Customer asked for a refund",
    })
    expect(result.subscription?.status).toBe("CANCELED")

    // The Refunded tab now shows the payment, with status REFUNDED.
    const after = await listPayments(ownerActor(), filtersFor("refunded"))
    expect(after.total).toBe(1)
    expect(after.payments).toHaveLength(1)
    expect(after.payments[0].id).toBe("ev-1")
    expect(after.payments[0].status).toBe("REFUNDED")
    expect(after.payments[0].amountMinor).toBe(2500)
    expect(after.payments[0].subscriptionId).toBe("sub-1")

    // The detail agrees: the recorded refund is visible there too.
    const detail = await getPaymentDetail(ownerActor(), event.id)
    expect(detail.payment.status).toBe("REFUNDED")

    // …and the 30-day refunded bucket counts it (paid no longer does).
    const stats = await getPaymentStats(ownerActor(), NOW)
    expect(stats.refunded30d.count).toBe(1)
    expect(stats.refunded30d.amountMinor).toBe(2500)
    expect(stats.paid30d.count).toBe(0)
  })

  it("a partial refund (subscription kept, REFUNDED timeline event) shows in the Refunded tab", async () => {
    const sub = seedSubscription({ id: "sub-1" })
    seedSubEvent({ subscriptionId: sub.id, providerEventId: "evt-1" })
    const event = seedEvent({
      id: "ev-1",
      kind: "PAYMENT_SUCCEEDED",
      providerEventId: "evt-1",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    await refundPayment(ownerActor(), event.id, {
      fullRefund: false,
      amountMinor: 1000,
      reason: "Partial goodwill refund",
    })
    // The subscription is still ACTIVE — the tab matches on the
    // REFUNDED timeline event, not on the subscription status.
    expect(store.subscriptions.get("sub-1")?.status).toBe("ACTIVE")
    const page = await listPayments(ownerActor(), filtersFor("refunded"))
    expect(page.total).toBe(1)
    expect(page.payments[0].id).toBe("ev-1")
    expect(page.payments[0].status).toBe("REFUNDED")
  })

  it("a normal provider cancel does NOT put the payment in the Refunded tab", async () => {
    const sub = seedSubscription({ id: "sub-1" })
    seedSubEvent({ subscriptionId: sub.id, providerEventId: "evt-1" })
    seedSubEvent({
      subscriptionId: sub.id,
      type: "CANCELED",
      reason: "Canceled by stripe (canceled)",
      createdAt: at("2026-11-26T11:00:00Z"),
    })
    seedEvent({
      id: "ev-1",
      kind: "PAYMENT_SUCCEEDED",
      providerEventId: "evt-1",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const page = await listPayments(ownerActor(), filtersFor("refunded"))
    expect(page.total).toBe(0)
    expect(page.payments).toHaveLength(0)
  })

  it("a refunded one-time purchase's covered event row shows in the Refunded tab", async () => {
    seedEvent({
      id: "ev-1",
      kind: "CHECKOUT_COMPLETED",
      eventType: "checkout.session.completed",
      providerEventId: "evt-co",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    seedPurchase({
      id: "otp-1",
      status: "REFUNDED",
      createdAt: at("2026-11-26T10:02:00Z"),
    })
    const page = await listPayments(ownerActor(), filtersFor("refunded"))
    // One row, not two: the covered purchase rides on its event row.
    expect(page.total).toBe(1)
    expect(page.payments[0].id).toBe("ev-1")
    expect(page.payments[0].status).toBe("REFUNDED")
  })

  it("a provider PAYMENT_REFUNDED event still shows (pre-existing behaviour)", async () => {
    seedEvent({
      id: "ev-ref",
      kind: "PAYMENT_REFUNDED",
      eventType: "charge.refunded",
      providerEventId: "evt-ref",
      userId: "user-2",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    const page = await listPayments(ownerActor(), filtersFor("refunded"))
    expect(page.total).toBe(1)
    expect(page.payments[0].id).toBe("ev-ref")
    expect(page.payments[0].status).toBe("REFUNDED")
  })

  it("the refunded payment still appears on the Succeeded tab (it did succeed — and was later refunded)", async () => {
    const sub = seedSubscription({ id: "sub-1" })
    seedSubEvent({ subscriptionId: sub.id, providerEventId: "evt-1" })
    const event = seedEvent({
      id: "ev-1",
      kind: "PAYMENT_SUCCEEDED",
      providerEventId: "evt-1",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    await refundPayment(ownerActor(), event.id, {
      fullRefund: true,
      reason: "Customer asked for a refund",
    })
    const page = await listPayments(ownerActor(), filtersFor("succeeded"))
    expect(page.total).toBe(1)
    expect(page.payments[0].id).toBe("ev-1")
  })
})
