// Phase 16, Wave 8 — Stream A (Billing P1 core).
//
// Regression tests for the 40 Stream A findings: provider cancel
// wiring (BIL-001/082), one-time grants (BIL-042/003), refunds
// (BIL-081/004/047), expiry (SRC-201), renewal guards (BIL-086),
// migration provider sync (BIL-089), and the DB backstops
// (DB-002/009/010/021/024/025/045). Plans service with a mocked
// Prisma client. No test hits the real DB.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@sendcms/database"
import type { AdminSession } from "@sendcms/auth"

const mockLogAudit = vi.hoisted(() => vi.fn(async () => {}))

const mockDb = vi.hoisted(() => ({
  plan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  planVersion: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  subscription: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  subscriptionEvent: {
    create: vi.fn(),
    findMany: vi.fn(),
    // Typed wide: tests resolve both null and row objects here.
    findFirst: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  },
  oneTimePurchase: {
    create: vi.fn(),
    findFirst: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  usageLedger: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    aggregate: vi.fn(),
  },
  entitlementOverride: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
  user: { findUnique: vi.fn(), findMany: vi.fn() },
  form: { count: vi.fn(), findMany: vi.fn() },
  domain: { count: vi.fn() },
  apiKey: { count: vi.fn(), findMany: vi.fn() },
  submission: { count: vi.fn(), findMany: vi.fn() },
  aiDailyUsage: { aggregate: vi.fn() },
  apiKeyRateLimit: { aggregate: vi.fn() },
  $executeRaw: vi.fn(async (...args: unknown[]) => {
    void args
    return 0
  }),
  $transaction: vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: typeof mockDb) => unknown)(mockDb)
    }
    if (Array.isArray(arg)) return Promise.all(arg)
    return arg
  }),
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/security")>()
  return { ...actual, logAudit: mockLogAudit }
})

import {
  ONE_TIME_ACCESS_DAYS,
  activateSubscriptionFromCheckout,
  applyRefund,
  cancelMySubscription,
  cancelSubscription,
  cancelSubscriptionFromProvider,
  executeMigration,
  expireSubscriptions,
  extendSubscriptionPeriod,
  getMigrationPreview,
  subscribeToFreePlan,
  syncSubscriptionFromProvider,
} from "@sendcms/plans"
import { FREE_PLAN_V1_ENTITLEMENTS } from "@sendcms/plans/validators"

const adminId = "admin-1"
const userId = "user-1"

function makeActor(
  overrides: Partial<AdminSession["user"]> = {}
): AdminSession {
  return {
    user: {
      id: adminId,
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
      userId: adminId,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    },
  }
}

const ownerActor = () =>
  makeActor({ id: "owner-1", platformRole: "PLATFORM_OWNER" })

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint", {
    code: "P2002",
    clientVersion: "1.0.0",
  })
}

function makeVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: "version-1",
    planId: "plan-1",
    plan: { name: "Free" },
    version: 1,
    status: "PUBLISHED",
    priceAmount: null,
    priceCurrency: "USD",
    billingInterval: "MONTHLY",
    trialDays: 0,
    entitlements: FREE_PLAN_V1_ENTITLEMENTS,
    changeReason: null,
    publishedAt: new Date("2026-11-01T00:00:00Z"),
    createdById: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  }
}

function makeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    userId,
    user: { id: userId, name: "Customer", email: "customer@example.com" },
    planId: "plan-1",
    plan: { id: "plan-1", name: "Free", slug: "free" },
    planVersionId: "version-1",
    planVersion: makeVersion(),
    status: "ACTIVE",
    currentPeriodStart: new Date("2026-11-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-12-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
    provider: null,
    providerSubscriptionId: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.user.findUnique.mockResolvedValue({
    id: userId,
    status: "ACTIVE",
    email: "user@example.com",
    name: "User",
  })
  mockDb.entitlementOverride.findMany.mockResolvedValue([])
  mockDb.subscription.findFirst.mockResolvedValue(null)
  mockDb.subscriptionEvent.findFirst.mockResolvedValue(null)
  mockDb.oneTimePurchase.findFirst.mockResolvedValue(null)
  mockDb.oneTimePurchase.updateMany.mockResolvedValue({ count: 0 })
  mockDb.subscription.updateMany.mockResolvedValue({ count: 1 })
  mockDb.planVersion.updateMany.mockResolvedValue({ count: 1 })
})

describe("one-time activation (BIL-003 / BIL-042)", () => {
  it("writes a separate OneTimePurchase row with a finite access date — never a lifetime flag", async () => {
    const before = new Date()
    mockDb.planVersion.findUnique.mockResolvedValue(
      makeVersion({
        id: "version-one",
        billingInterval: "ONE_TIME",
        priceAmount: 9900,
        priceCurrency: "USD",
      })
    )
    mockDb.subscription.create.mockResolvedValue({ id: "sub-1" })
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({
        planVersionId: "version-one",
        provider: "POLAR",
        providerSubscriptionId: "order_123",
      })
    )

    await activateSubscriptionFromCheckout({
      userId,
      planVersionId: "version-one",
      provider: "POLAR",
      providerSubscriptionId: "order_123",
      isOneTime: true,
      providerReference: "order_123",
      checkoutId: "checkout_123",
    })

    expect(mockDb.oneTimePurchase.create).toHaveBeenCalledTimes(1)
    const data = mockDb.oneTimePurchase.create.mock.calls[0][0].data as {
      accessStart: Date
      accessEnd: Date
      status: string
      providerReference: string
      checkoutId: string
    }
    expect(data.status).toBe("ACTIVE")
    expect(data.providerReference).toBe("order_123")
    expect(data.checkoutId).toBe("checkout_123")
    // Finite: exactly ONE_TIME_ACCESS_DAYS after the access start.
    const days =
      (data.accessEnd.getTime() - data.accessStart.getTime()) / 86400000
    expect(days).toBe(ONE_TIME_ACCESS_DAYS)
    expect(data.accessStart.getTime()).toBeGreaterThanOrEqual(before.getTime())
    // The subscription row's period end IS the access end.
    const subData = mockDb.subscription.create.mock.calls[0][0].data as {
      currentPeriodEnd: Date
    }
    expect(subData.currentPeriodEnd.getTime()).toBe(data.accessEnd.getTime())
  })

  it("infers one-time from a ONE_TIME version even without the flag", async () => {
    mockDb.planVersion.findUnique.mockResolvedValue(
      makeVersion({
        id: "version-one",
        billingInterval: "ONE_TIME",
        priceAmount: 9900,
      })
    )
    mockDb.subscription.create.mockResolvedValue({ id: "sub-1" })
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({ planVersionId: "version-one" })
    )

    await activateSubscriptionFromCheckout({
      userId,
      planVersionId: "version-one",
      provider: "STRIPE",
      providerSubscriptionId: "pi_123",
    })

    expect(mockDb.oneTimePurchase.create).toHaveBeenCalledTimes(1)
  })
})

describe("remaining paid period (BIL-007)", () => {
  it("carries the remaining paid period forward on re-checkout", async () => {
    const now = Date.now()
    const remainingEnd = new Date(now + 60 * 86400000) // 60 days out
    mockDb.planVersion.findUnique.mockResolvedValue(makeVersion())
    mockDb.subscription.findFirst
      .mockResolvedValueOnce(null) // no duplicate
      .mockResolvedValueOnce(
        makeSubscription({ currentPeriodEnd: remainingEnd })
      ) // previous
    mockDb.subscription.create.mockResolvedValue({ id: "sub-2" })
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({ id: "sub-2", currentPeriodEnd: remainingEnd })
    )

    const result = await activateSubscriptionFromCheckout({
      userId,
      planVersionId: "version-1",
      provider: "STRIPE",
      providerSubscriptionId: "sub_9",
    })

    expect(result.currentPeriodEnd).toEqual(remainingEnd)
    const subData = mockDb.subscription.create.mock.calls[0][0].data as {
      currentPeriodEnd: Date
    }
    // The new end is the OLD end, not the freshly computed month.
    expect(subData.currentPeriodEnd).toEqual(remainingEnd)
    expect(mockDb.subscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "CANCELED",
          reason: expect.stringContaining("remaining paid period preserved"),
        }),
      })
    )
  })
})

describe("activate idempotency backstop (DB-024)", () => {
  it("returns the existing row when the unique index fires on create", async () => {
    mockDb.planVersion.findUnique.mockResolvedValue(makeVersion())
    mockDb.subscription.findFirst
      .mockResolvedValueOnce(null) // duplicate guard
      .mockResolvedValueOnce(null) // previous
      .mockResolvedValueOnce(
        makeSubscription({
          provider: "STRIPE",
          providerSubscriptionId: "sub_9",
        })
      ) // P2002 catch re-read
    mockDb.subscription.create.mockRejectedValueOnce(p2002())

    const result = await activateSubscriptionFromCheckout({
      userId,
      planVersionId: "version-1",
      provider: "STRIPE",
      providerSubscriptionId: "sub_9",
    })

    expect(result.id).toBe("sub-1")
    expect(result.providerSubscriptionId).toBe("sub_9")
  })
})

describe("provider cancel wiring (BIL-001 / BIL-082)", () => {
  function providerRow() {
    return makeSubscription({
      provider: "STRIPE",
      providerSubscriptionId: "sub_123",
    })
  }

  it("admin cancel calls the provider FIRST, then cancels locally", async () => {
    mockDb.subscription.findUnique.mockResolvedValue(providerRow())
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({
        status: "CANCELED",
        provider: "STRIPE",
        providerSubscriptionId: "sub_123",
      })
    )
    const cancelAtProvider = vi.fn(async () => ({
      canceledAtProvider: true,
      immediate: true,
    }))

    const canceled = await cancelSubscription(
      ownerActor(),
      "sub-1",
      {},
      {
        cancelAtProvider,
      }
    )

    expect(cancelAtProvider).toHaveBeenCalledWith("STRIPE", {
      providerSubscriptionId: "sub_123",
      cancelAtPeriodEnd: false,
    })
    expect(canceled.status).toBe("CANCELED")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          providerCanceled: true,
          providerImmediate: true,
        }),
      })
    )
  })

  it("admin cancel stops when the provider cancel fails — the local row is untouched", async () => {
    mockDb.subscription.findUnique.mockResolvedValue(providerRow())
    const cancelAtProvider = vi.fn(async () => {
      throw new Error("Stripe cancel failed: timeout")
    })

    await expect(
      cancelSubscription(ownerActor(), "sub-1", {}, { cancelAtProvider })
    ).rejects.toThrow("Stripe cancel failed")
    expect(mockDb.subscription.updateMany).not.toHaveBeenCalled()
    expect(mockDb.subscriptionEvent.create).not.toHaveBeenCalled()
  })

  it("a provider that only cancels immediately mirrors a period-end request as an immediate cancel", async () => {
    mockDb.subscription.findUnique.mockResolvedValue(providerRow())
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({
        status: "CANCELED",
        provider: "PAYPAL",
        providerSubscriptionId: "I-123",
      })
    )
    const cancelAtProvider = vi.fn(async () => ({
      canceledAtProvider: true,
      immediate: true,
      note: "PayPal has no cancel-at-period-end — canceled immediately.",
    }))

    const canceled = await cancelSubscription(
      ownerActor(),
      "sub-1",
      { cancelAtPeriodEnd: true },
      { cancelAtProvider }
    )

    expect(canceled.status).toBe("CANCELED")
    expect(mockDb.subscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "CANCELED" }),
      })
    )
  })

  it("a provider-scheduled cancel keeps the row ACTIVE with a CANCEL_SCHEDULED event (DB-045)", async () => {
    mockDb.subscription.findUnique.mockResolvedValue(providerRow())
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({
        cancelAtPeriodEnd: true,
        provider: "STRIPE",
        providerSubscriptionId: "sub_123",
      })
    )
    const cancelAtProvider = vi.fn(async () => ({
      canceledAtProvider: true,
      immediate: false,
    }))

    const scheduled = await cancelSubscription(
      ownerActor(),
      "sub-1",
      { cancelAtPeriodEnd: true },
      { cancelAtProvider }
    )

    expect(scheduled.status).toBe("ACTIVE")
    expect(scheduled.cancelAtPeriodEnd).toBe(true)
    expect(mockDb.subscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "CANCEL_SCHEDULED" }),
      })
    )
  })

  it("customer cancel calls the provider and records the outcome", async () => {
    mockDb.subscription.findFirst.mockResolvedValue(providerRow())
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({
        status: "CANCELED",
        provider: "STRIPE",
        providerSubscriptionId: "sub_123",
      })
    )
    const cancelAtProvider = vi.fn(async () => ({
      canceledAtProvider: true,
      immediate: true,
    }))

    const canceled = await cancelMySubscription(
      userId,
      {},
      {
        cancelAtProvider,
      }
    )

    expect(cancelAtProvider).toHaveBeenCalledTimes(1)
    expect(canceled.status).toBe("CANCELED")
  })
})

describe("concurrent provider cancels (DB-025)", () => {
  it("two concurrent cancels write exactly one CANCELED event", async () => {
    const active = makeSubscription({
      provider: "STRIPE",
      providerSubscriptionId: "sub_123",
    })
    const canceled = makeSubscription({
      status: "CANCELED",
      provider: "STRIPE",
      providerSubscriptionId: "sub_123",
    })
    mockDb.subscription.findFirst
      .mockResolvedValueOnce(active) // call 1: live row
      .mockResolvedValueOnce(null) // call 2: no live row
      .mockResolvedValueOnce(canceled) // call 2: already-canceled row
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(canceled)
    // Only the first cancel reaches the conditional update — the
    // second short-circuits at the already-canceled lookup and
    // never calls updateMany. (Do NOT queue a second once-value
    // here: an unconsumed once-value leaks into the next test,
    // because vi.clearAllMocks clears calls, not queued values.)
    mockDb.subscription.updateMany.mockResolvedValueOnce({ count: 1 })

    const first = await cancelSubscriptionFromProvider(
      "STRIPE",
      "sub_123",
      "test"
    )
    const second = await cancelSubscriptionFromProvider(
      "STRIPE",
      "sub_123",
      "test"
    )

    expect(first?.status).toBe("CANCELED")
    expect(second?.status).toBe("CANCELED")
    const canceledEvents = mockDb.subscriptionEvent.create.mock.calls.filter(
      ([args]) => (args as { data: { type: string } }).data.type === "CANCELED"
    )
    expect(canceledEvents).toHaveLength(1)
  })
})

describe("renewal guards (BIL-086 / DB-010)", () => {
  function extendRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "sub-1",
      userId,
      planVersionId: "version-1",
      planVersion: { billingInterval: "MONTHLY" },
      status: "ACTIVE",
      currentPeriodEnd: new Date("2026-12-01T00:00:00Z"),
      cancelAtPeriodEnd: false,
      createdAt: new Date("2026-11-01T00:00:00Z"),
      updatedAt: new Date("2026-11-01T00:00:00Z"),
      ...overrides,
    }
  }

  it("a renewal on a cancelAtPeriodEnd subscription CANCELS instead of extending", async () => {
    mockDb.subscription.findFirst.mockResolvedValue(
      extendRow({ cancelAtPeriodEnd: true })
    )
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({ status: "CANCELED" })
    )

    const result = await extendSubscriptionPeriod(
      "STRIPE",
      "sub_1",
      new Date("2027-01-01T00:00:00Z")
    )

    expect(result?.status).toBe("CANCELED")
    expect(mockDb.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "CANCELED", cancelAtPeriodEnd: false },
      })
    )
    expect(mockDb.subscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "CANCELED" }),
      })
    )
    expect(
      mockDb.subscriptionEvent.create.mock.calls.some(
        ([args]) => (args as { data: { type: string } }).data.type === "RENEWED"
      )
    ).toBe(false)
  })

  it("a retried renewal with the same provider event id is a no-op (DB-010)", async () => {
    mockDb.subscription.findFirst.mockResolvedValue(extendRow())
    mockDb.subscriptionEvent.findFirst.mockResolvedValue({
      id: "ev-renewed",
      type: "RENEWED",
      providerEventId: "evt_123",
    })
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({ currentPeriodEnd: new Date("2027-01-01T00:00:00Z") })
    )

    const result = await extendSubscriptionPeriod(
      "STRIPE",
      "sub_1",
      new Date("2027-01-01T00:00:00Z"),
      "evt_123"
    )

    expect(result?.currentPeriodEnd).toEqual(new Date("2027-01-01T00:00:00Z"))
    expect(mockDb.subscription.update).not.toHaveBeenCalled()
    expect(mockDb.subscriptionEvent.create).not.toHaveBeenCalled()
  })

  it("a first renewal with an event id stamps the RENEWED event with it", async () => {
    mockDb.subscription.findFirst.mockResolvedValue(extendRow())
    mockDb.subscription.update.mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        makeSubscription({ ...(args.data as Record<string, unknown>) })
    )
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({ currentPeriodEnd: new Date("2027-01-01T00:00:00Z") })
    )

    await extendSubscriptionPeriod(
      "STRIPE",
      "sub_1",
      new Date("2027-01-01T00:00:00Z"),
      "evt_123"
    )

    expect(mockDb.subscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "RENEWED",
          providerEventId: "evt_123",
        }),
      })
    )
  })
})

describe("refunds (BIL-081 / BIL-004 / BIL-047)", () => {
  it("a FULL refund cancels the subscription and marks the linked purchase REFUNDED", async () => {
    const active = makeSubscription({
      provider: "STRIPE",
      providerSubscriptionId: "sub_123",
    })
    mockDb.subscription.findFirst.mockResolvedValue(active)
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({ status: "CANCELED" })
    )

    const result = await applyRefund("STRIPE", {
      providerSubscriptionId: "sub_123",
      fullRefund: true,
      amountMinor: 9900,
    })

    expect(result?.status).toBe("CANCELED")
    expect(mockDb.subscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "CANCELED" }),
      })
    )
    expect(mockDb.oneTimePurchase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ subscriptionId: "sub-1" }),
        data: { status: "REFUNDED" },
      })
    )
  })

  it("a PARTIAL refund keeps the subscription and writes a REFUNDED timeline event", async () => {
    const active = makeSubscription({
      provider: "POLAR",
      providerSubscriptionId: "sub_pol_1",
    })
    mockDb.subscription.findFirst.mockResolvedValue(active)
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(active)

    const result = await applyRefund("POLAR", {
      providerSubscriptionId: "sub_pol_1",
      fullRefund: false,
      amountMinor: 2000,
    })

    expect(result?.status).toBe("ACTIVE")
    expect(mockDb.subscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "REFUNDED",
          reason: expect.stringContaining("subscription kept"),
        }),
      })
    )
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          event: "subscription-partial-refund",
        }),
      })
    )
  })

  it("a refund for a one-time purchase reference flips the purchase to REFUNDED", async () => {
    // applyRefund's subscription lookup misses (providerSubscriptionId
    // is null, so that branch is skipped), the purchase lookup hits,
    // and the full refund then cancels the linked subscription.
    // cancelSubscriptionFromProvider's live lookup must return the
    // ACTIVE row for the cancel to happen.
    mockDb.subscription.findFirst.mockResolvedValue(
      makeSubscription({
        provider: "POLAR",
        providerSubscriptionId: "order_123",
      })
    )
    mockDb.oneTimePurchase.findFirst.mockResolvedValue({
      id: "otp-1",
      userId,
      planId: "plan-1",
      planVersionId: "version-1",
      subscriptionId: "sub-1",
      provider: "POLAR",
      providerReference: "order_123",
      status: "ACTIVE",
    })
    mockDb.subscription.findUnique.mockResolvedValue(
      makeSubscription({
        provider: "POLAR",
        providerSubscriptionId: "order_123",
      })
    )
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({ status: "CANCELED" })
    )

    const result = await applyRefund("POLAR", {
      providerSubscriptionId: null,
      providerReference: "order_123",
      fullRefund: true,
    })

    expect(mockDb.oneTimePurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "otp-1" },
        data: { status: "REFUNDED" },
      })
    )
    expect(result?.status).toBe("CANCELED")
  })

  it("an unmatched refund returns null (the billing service logs it)", async () => {
    mockDb.subscription.findFirst.mockResolvedValue(null)
    mockDb.oneTimePurchase.findFirst.mockResolvedValue(null)

    const result = await applyRefund("STRIPE", {
      providerSubscriptionId: "sub_unknown",
      fullRefund: true,
    })

    expect(result).toBeNull()
  })
})

describe("provider sync (BIL-005 / BIL-006 / BIL-045)", () => {
  it("syncs a period end without an event", async () => {
    const active = makeSubscription({
      provider: "STRIPE",
      providerSubscriptionId: "sub_123",
    })
    mockDb.subscription.findFirst.mockResolvedValue(active)
    mockDb.subscription.update.mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        makeSubscription({ ...(args.data as Record<string, unknown>) })
    )
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({ currentPeriodEnd: new Date("2027-01-01T00:00:00Z") })
    )

    const result = await syncSubscriptionFromProvider("STRIPE", "sub_123", {
      status: "active",
      periodEnd: new Date("2027-01-01T00:00:00Z"),
      cancelAtPeriodEnd: false,
    })

    expect(result?.currentPeriodEnd).toEqual(new Date("2027-01-01T00:00:00Z"))
    expect(mockDb.subscriptionEvent.create).not.toHaveBeenCalled()
  })

  it("a past_due sync flips to PAST_DUE with a PAYMENT_FAILED event", async () => {
    mockDb.subscription.findFirst.mockResolvedValue(
      makeSubscription({
        provider: "POLAR",
        providerSubscriptionId: "sub_pol_1",
      })
    )
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({ status: "PAST_DUE" })
    )

    const result = await syncSubscriptionFromProvider("POLAR", "sub_pol_1", {
      status: "past_due",
    })

    expect(result?.status).toBe("PAST_DUE")
    expect(mockDb.subscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "PAYMENT_FAILED" }),
      })
    )
  })

  it("a canceled sync cancels with one CANCELED event", async () => {
    mockDb.subscription.findFirst.mockResolvedValue(
      makeSubscription({
        provider: "PAYPAL",
        providerSubscriptionId: "I-123",
      })
    )
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({ status: "CANCELED" })
    )

    const result = await syncSubscriptionFromProvider("PAYPAL", "I-123", {
      status: "canceled",
    })

    expect(result?.status).toBe("CANCELED")
    expect(mockDb.subscriptionEvent.create).toHaveBeenCalledTimes(1)
  })

  it("a plan change moves the version with a MIGRATED event", async () => {
    mockDb.subscription.findFirst.mockResolvedValue(
      makeSubscription({
        provider: "STRIPE",
        providerSubscriptionId: "sub_123",
      })
    )
    mockDb.planVersion.findUnique.mockResolvedValue(
      makeVersion({
        id: "version-2",
        planId: "plan-1",
        version: 2,
        priceAmount: 19900,
      })
    )
    mockDb.subscription.update.mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        makeSubscription({ ...(args.data as Record<string, unknown>) })
    )
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({ planVersionId: "version-2" })
    )

    const result = await syncSubscriptionFromProvider("STRIPE", "sub_123", {
      status: "active",
      planVersionId: "version-2",
    })

    expect(result?.planVersionId).toBe("version-2")
    expect(mockDb.subscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "MIGRATED",
          toPlanVersionId: "version-2",
        }),
      })
    )
  })
})

describe("expiry job — one-time purchases (SRC-201 / BIL-003)", () => {
  const now = new Date("2026-11-24T12:00:00Z")
  const yesterday = new Date("2026-11-23T12:00:00Z")

  it("expires ACTIVE one-time purchases past their access date", async () => {
    mockDb.subscription.findMany.mockResolvedValue([])
    mockDb.subscription.update.mockResolvedValue({})

    await expireSubscriptions(now)

    expect(mockDb.oneTimePurchase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "ACTIVE", accessEnd: { lt: now } },
        data: { status: "EXPIRED" },
      })
    )
  })

  it("expires the linked purchase when its subscription expires", async () => {
    mockDb.subscription.findMany.mockResolvedValue([
      {
        id: "sub-1",
        userId,
        planVersionId: "version-1",
        status: "ACTIVE",
        currentPeriodEnd: yesterday,
        cancelAtPeriodEnd: false,
        updatedAt: new Date("2026-11-01T00:00:00Z"),
      },
    ])
    mockDb.subscription.update.mockResolvedValue({})

    const results = await expireSubscriptions(now)

    expect(results).toHaveLength(1)
    expect(results[0].toStatus).toBe("EXPIRED")
    expect(mockDb.oneTimePurchase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { subscriptionId: "sub-1", status: "ACTIVE" },
        data: { status: "EXPIRED" },
      })
    )
  })

  it("dryRun touches no purchase rows", async () => {
    mockDb.subscription.findMany.mockResolvedValue([])
    await expireSubscriptions(now, { dryRun: true })
    expect(mockDb.oneTimePurchase.updateMany).not.toHaveBeenCalled()
  })
})

describe("migration provider sync (BIL-089)", () => {
  function targetVersion() {
    return makeVersion({
      id: "version-2",
      planId: "plan-1",
      version: 2,
      priceAmount: 19900,
    })
  }

  function activeRow(provider: string | null) {
    return makeSubscription({
      planVersionId: "version-1",
      currentPeriodEnd: new Date("2027-01-01T00:00:00Z"),
      provider,
      providerSubscriptionId: provider ? "sub_123" : null,
    })
  }

  function seedPreviewRows(rows: ReturnType<typeof makeSubscription>[]) {
    mockDb.planVersion.findUnique.mockResolvedValue(targetVersion())
    mockDb.plan.findUniqueOrThrow.mockResolvedValue({
      id: "plan-1",
      name: "Pro",
      slug: "pro",
    })
    mockDb.subscription.findMany.mockResolvedValue(rows)
    mockDb.subscription.count.mockResolvedValue(rows.length)
  }

  it("preview: a Freemius row is SendCMS-only — billingUnchanged, with a note", async () => {
    seedPreviewRows([activeRow("FREEMIUS")])

    const preview = await getMigrationPreview(ownerActor(), {
      planVersionId: "version-2",
      userIds: [userId],
    })

    expect(preview.billingUnchanged).toBe(true)
    expect(preview.providerUpdateSupported).toBe(false)
    // The note names the provider enum (FREEMIUS) — the admin copy
    // uses the provider id, not a display name.
    expect(preview.providerUpdateNote).toContain("FREEMIUS")
  })

  it("preview: all-Stripe rows are provider-synced", async () => {
    seedPreviewRows([activeRow("STRIPE")])

    const preview = await getMigrationPreview(ownerActor(), {
      planVersionId: "version-2",
      userIds: [userId],
    })

    expect(preview.billingUnchanged).toBe(false)
    expect(preview.providerUpdateSupported).toBe(true)
    expect(preview.providerUpdateNote).toBeUndefined()
  })

  it("execute: the provider is updated BEFORE the local row moves", async () => {
    mockDb.planVersion.findUnique.mockResolvedValue(targetVersion())
    mockDb.subscription.findFirst.mockResolvedValue(activeRow("STRIPE"))
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({ planVersionId: "version-2" })
    )
    const updateAtProvider = vi.fn(async () => ({ updated: true }))
    const order: string[] = []
    updateAtProvider.mockImplementation(async () => {
      order.push("provider")
      return { updated: true }
    })
    mockDb.subscription.updateMany.mockImplementation(async () => {
      order.push("local")
      return { count: 1 }
    })

    const result = await executeMigration(
      ownerActor(),
      { planVersionId: "version-2", userIds: [userId], reason: "Move to v2" },
      { updateAtProvider }
    )

    expect(result.migratedUserIds).toEqual([userId])
    expect(updateAtProvider).toHaveBeenCalledWith(
      "STRIPE",
      "sub_123",
      expect.objectContaining({
        version: expect.objectContaining({
          id: "version-2",
          planName: expect.any(String),
        }),
        customer: expect.objectContaining({
          userId,
          email: "user@example.com",
        }),
        idempotencyKey: expect.stringContaining("migration:version-2:"),
      })
    )
    expect(order).toEqual(["provider", "local"])
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          providerUpdateNotes: {},
        }),
      })
    )
  })

  it("execute: a provider failure fails that user and leaves the local row untouched", async () => {
    mockDb.planVersion.findUnique.mockResolvedValue(targetVersion())
    mockDb.subscription.findFirst.mockResolvedValue(activeRow("STRIPE"))
    const updateAtProvider = vi.fn(async () => {
      throw new Error("Polar update failed: 502")
    })

    const result = await executeMigration(
      ownerActor(),
      { planVersionId: "version-2", userIds: [userId], reason: "Move to v2" },
      { updateAtProvider }
    )

    expect(result.failedUserIds).toEqual([userId])
    expect(result.migratedUserIds).toEqual([])
    expect(mockDb.subscription.updateMany).not.toHaveBeenCalled()
  })

  it("execute: an unsupported provider migrates SendCMS-only and the reason is audited", async () => {
    mockDb.planVersion.findUnique.mockResolvedValue(targetVersion())
    mockDb.subscription.findFirst.mockResolvedValue(activeRow("FREEMIUS"))
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({ planVersionId: "version-2" })
    )
    const updateAtProvider = vi.fn(async () => ({
      updated: false,
      reason: "Freemius has no subscription plan-change API.",
    }))

    const result = await executeMigration(
      ownerActor(),
      { planVersionId: "version-2", userIds: [userId], reason: "Move to v2" },
      { updateAtProvider }
    )

    expect(result.migratedUserIds).toEqual([userId])
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          providerUpdateNotes: {
            [userId]: expect.stringContaining("Freemius"),
          },
        }),
      })
    )
  })
})

describe("free-plan subscribe supersedes PAST_DUE too (DB-021)", () => {
  it("cancels a PAST_DUE row before creating the Free subscription", async () => {
    mockDb.planVersion.findUnique.mockResolvedValue(makeVersion())
    const pastDue = makeSubscription({
      status: "PAST_DUE",
      planVersionId: "pv-pro",
      planId: "plan-pro",
    })
    mockDb.subscription.findFirst
      .mockResolvedValueOnce(null) // findActiveSubscription: none live
      .mockResolvedValueOnce(pastDue) // in-transaction supersede lookup
    mockDb.subscription.create.mockResolvedValue({ id: "sub-2" })
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({ id: "sub-2" })
    )

    const created = await subscribeToFreePlan(userId, {
      planVersionId: "version-1",
    })

    expect(created.id).toBe("sub-2")
    expect(mockDb.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "sub-1" }),
        data: { status: "CANCELED" },
      })
    )
    expect(mockDb.subscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "CANCELED",
          reason: "Replaced by a free-plan subscribe.",
        }),
      })
    )
  })
})
