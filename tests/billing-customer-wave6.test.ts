// Phase 16, Wave 6 — Stream A (customer billing).
//
// BIL-120: subscribeToFreePlan — free versions only, one active
// subscription per user, idempotent re-subscribe to the same version.
// BIL-122 / BIL-091: cancelMySubscription — the customer's own
// subscription only, immediate or at period end, 404 with none,
// 409 when already canceled.
// BIL-124 / AIM-014: getMyUsage — the caller's own meters +
// entitlements, via the same live counts enforcement uses.
//
// Plans service with a mocked Prisma client. No test hits the real DB.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FREE_PLAN_V1_ENTITLEMENTS } from "@sendcms/plans/validators"

const mockLogAudit = vi.hoisted(() => vi.fn(async () => undefined))

type StoredVersion = {
  id: string
  planId: string
  status: string
  priceAmount: number | null
  priceCurrency: string
  billingInterval: string
  trialDays: number
  version: number
  entitlements: Record<string, unknown>
  plan: { name: string }
}

type StoredSub = {
  id: string
  userId: string
  planId: string
  planVersionId: string
  status: string
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  provider: string | null
  providerSubscriptionId: string | null
  createdAt: Date
  updatedAt: Date
}

const { store, mockDb } = vi.hoisted(() => {
  const store = {
    versions: new Map<string, StoredVersion>(),
    subscriptions: [] as StoredSub[],
    events: [] as Record<string, unknown>[],
    subSeq: 1,
  }

  function toRow(sub: StoredSub) {
    const version = store.versions.get(sub.planVersionId)
    return {
      ...sub,
      user: { id: sub.userId, name: "User", email: "user@example.com" },
      plan: { id: sub.planId, name: "Free", slug: "free" },
      planVersion: version
        ? { ...version, plan: { name: "Free" } }
        : {
            id: sub.planVersionId,
            planId: sub.planId,
            plan: { name: "Free" },
            version: 1,
            priceAmount: null,
            priceCurrency: "USD",
            billingInterval: "MONTHLY",
            trialDays: 0,
          },
    }
  }

  function findSub(where: {
    userId?: string
    status?: { in?: string[] }
  }): StoredSub | null {
    const matches = store.subscriptions
      .filter((s) => (where.userId ? s.userId === where.userId : true))
      .filter((s) =>
        where.status?.in ? where.status.in.includes(s.status) : true
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    return matches[0] ?? null
  }

  const mockDb = {
    planVersion: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          store.versions.get(where.id) ?? null
      ),
    },
    plan: {
      findFirst: vi.fn(async () => ({
        id: "plan-free",
        slug: "free",
        status: "PUBLISHED",
        currentVersion: {
          id: "pv-free",
          entitlements: FREE_PLAN_V1_ENTITLEMENTS,
        },
      })),
    },
    subscription: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { userId?: string; status?: { in?: string[] } }
        }) => {
          const found = findSub(where)
          return found ? toRow(found) : null
        }
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const found = store.subscriptions.find((s) => s.id === where.id)
        if (!found) throw new Error("not found")
        return toRow(found)
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const sub: StoredSub = {
          id: `sub-${store.subSeq++}`,
          userId: data.userId as string,
          planId: data.planId as string,
          planVersionId: data.planVersionId as string,
          status: data.status as string,
          currentPeriodStart: (data.currentPeriodStart as Date) ?? null,
          currentPeriodEnd: (data.currentPeriodEnd as Date) ?? null,
          cancelAtPeriodEnd: (data.cancelAtPeriodEnd as boolean) ?? false,
          provider: null,
          providerSubscriptionId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        store.subscriptions.push(sub)
        return toRow(sub)
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string }
          data: Record<string, unknown>
        }) => {
          const found = store.subscriptions.find((s) => s.id === where.id)
          if (!found) throw new Error("not found")
          Object.assign(found, data, { updatedAt: new Date() })
          return toRow(found)
        }
      ),
      // Wave 8 (DB-025): cancels + supersedes are conditional
      // updateMany calls — only while the row still holds a live
      // status. The store applies the data when the status matches.
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status?: { in?: string[]; notIn?: string[] } }
          data: Record<string, unknown>
        }) => {
          const found = store.subscriptions.find((s) => s.id === where.id)
          if (!found) return { count: 0 }
          if (where.status?.in && !where.status.in.includes(found.status)) {
            return { count: 0 }
          }
          if (
            where.status?.notIn &&
            where.status.notIn.includes(found.status)
          ) {
            return { count: 0 }
          }
          Object.assign(found, data, { updatedAt: new Date() })
          return { count: 1 }
        }
      ),
    },
    subscriptionEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `ev-${store.events.length + 1}`, ...data }
        store.events.push(row)
        return row
      }),
    },
    entitlementOverride: { findMany: vi.fn(async () => []) },
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", status: "ACTIVE" })),
    },
    form: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    },
    domain: { count: vi.fn(async () => 0) },
    apiKey: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    },
    submission: { count: vi.fn(async () => 0) },
    aiDailyUsage: { aggregate: vi.fn(async () => ({ _sum: { calls: 0 } })) },
    // Wave 8 (AIM-028, Stream C): getMyUsage also sums the
    // per-owner interactive usage — the mock needs the model or
    // the meter read crashes on `db.aiDailyOwnerUsage.aggregate`.
    aiDailyOwnerUsage: {
      aggregate: vi.fn(async () => ({ _sum: { calls: 0 } })),
    },
    apiKeyRateLimit: {
      aggregate: vi.fn(async () => ({ _sum: { hourCount: 0 } })),
    },
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === "function") {
        return (arg as (tx: typeof mockDb) => unknown)(mockDb)
      }
      if (Array.isArray(arg)) return Promise.all(arg)
      return arg
    }),
  }
  return { store, mockDb }
})

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/security")>()
  return { ...actual, logAudit: mockLogAudit }
})

import {
  cancelMySubscription,
  getMyUsage,
  subscribeToFreePlan,
} from "@sendcms/plans"
import { ApiError } from "@sendcms/api-client"

const userId = "user-1"

function freeVersion(overrides: Partial<StoredVersion> = {}): StoredVersion {
  return {
    id: "pv-free",
    planId: "plan-free",
    status: "PUBLISHED",
    priceAmount: null,
    priceCurrency: "USD",
    billingInterval: "MONTHLY",
    trialDays: 0,
    version: 1,
    entitlements: FREE_PLAN_V1_ENTITLEMENTS as Record<string, unknown>,
    plan: { name: "Free" },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  store.versions.clear()
  store.subscriptions.length = 0
  store.events.length = 0
  store.subSeq = 1
  store.versions.set("pv-free", freeVersion())
  store.versions.set(
    "pv-pro",
    freeVersion({
      id: "pv-pro",
      planId: "plan-pro",
      priceAmount: 9900,
      plan: { name: "Pro" },
    })
  )
})

async function expectApiError(
  promise: Promise<unknown>,
  status: number
): Promise<ApiError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(status)
    return err as ApiError
  }
  throw new Error(`expected ApiError ${status}, promise resolved`)
}

describe("subscribeToFreePlan (BIL-120)", () => {
  it("creates an ACTIVE subscription on the published Free version", async () => {
    const created = await subscribeToFreePlan(userId, {
      planVersionId: "pv-free",
    })
    expect(created.status).toBe("ACTIVE")
    expect(created.planVersionId).toBe("pv-free")
    expect(created.userId).toBe(userId)
    expect(created.currentPeriodEnd).not.toBeNull()
    expect(store.subscriptions).toHaveLength(1)
    expect(store.events.filter((e) => e.type === "CREATED")).toHaveLength(1)
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          event: "subscription-subscribed-free",
        }),
      })
    )
  })

  it("is an idempotent no-op when already on the same Free version", async () => {
    const first = await subscribeToFreePlan(userId, {
      planVersionId: "pv-free",
    })
    const second = await subscribeToFreePlan(userId, {
      planVersionId: "pv-free",
    })
    expect(second.id).toBe(first.id)
    expect(store.subscriptions).toHaveLength(1)
  })

  it("422s for a paid version", async () => {
    await expectApiError(
      subscribeToFreePlan(userId, { planVersionId: "pv-pro" }),
      422
    )
    expect(store.subscriptions).toHaveLength(0)
  })

  it("409s for an unpublished version", async () => {
    store.versions.set(
      "pv-draft",
      freeVersion({ id: "pv-draft", status: "DRAFT" })
    )
    await expectApiError(
      subscribeToFreePlan(userId, { planVersionId: "pv-draft" }),
      409
    )
  })

  it("404s for an unknown version", async () => {
    await expectApiError(
      subscribeToFreePlan(userId, { planVersionId: "pv-nope" }),
      404
    )
  })

  it("409s when the user already holds a different active plan", async () => {
    // A paid subscription assigned out of band (e.g. by an admin).
    store.subscriptions.push({
      id: "sub-paid",
      userId,
      planId: "plan-pro",
      planVersionId: "pv-pro",
      status: "ACTIVE",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 86400000),
      cancelAtPeriodEnd: false,
      provider: "STRIPE",
      providerSubscriptionId: "sub_123",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await expectApiError(
      subscribeToFreePlan(userId, { planVersionId: "pv-free" }),
      409
    )
    expect(store.subscriptions).toHaveLength(1)
  })
})

describe("cancelMySubscription (BIL-122 / BIL-091)", () => {
  async function seedActive(): Promise<string> {
    const created = await subscribeToFreePlan(userId, {
      planVersionId: "pv-free",
    })
    return created.id
  }

  it("cancels immediately with a CANCELED event + audit", async () => {
    const id = await seedActive()
    const canceled = await cancelMySubscription(userId, {})
    expect(canceled.id).toBe(id)
    expect(canceled.status).toBe("CANCELED")
    expect(store.events.filter((e) => e.type === "CANCELED")).toHaveLength(1)
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          event: "subscription-canceled-by-customer",
          // Wave 8 (DSH-402): the audit no longer carries
          // providerCancelPending — a provider row with no callback
          // is a 502, and a provider cancel is recorded as
          // providerCanceled below.
          provider: null,
          providerSubscriptionId: null,
        }),
      })
    )
  })

  it("cancels at the provider first when a provider subscription is attached (DSH-402 / BIL-001)", async () => {
    await seedActive()
    const row = store.subscriptions[0]
    row.provider = "STRIPE"
    row.providerSubscriptionId = "sub_123"
    const cancelAtProvider = vi.fn(async () => ({
      canceledAtProvider: true,
      immediate: true,
    }))
    const canceled = await cancelMySubscription(
      userId,
      {},
      { cancelAtProvider }
    )
    expect(canceled.status).toBe("CANCELED")
    expect(cancelAtProvider).toHaveBeenCalledWith("STRIPE", {
      providerSubscriptionId: "sub_123",
      cancelAtPeriodEnd: false,
    })
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          provider: "STRIPE",
          providerSubscriptionId: "sub_123",
          providerCanceled: true,
          providerImmediate: true,
        }),
      })
    )
  })

  it("refuses the cancel when the provider cancel fails (BIL-001)", async () => {
    await seedActive()
    const row = store.subscriptions[0]
    row.provider = "STRIPE"
    row.providerSubscriptionId = "sub_123"
    const cancelAtProvider = vi.fn(async () => {
      throw new ApiError("Stripe cancel failed: timeout", 502)
    })
    await expectApiError(
      cancelMySubscription(userId, {}, { cancelAtProvider }),
      502
    )
    // The local row is untouched — billing continues at the provider
    // until the cancel actually lands there.
    expect(store.subscriptions[0].status).toBe("ACTIVE")
    expect(store.events.filter((e) => e.type === "CANCELED")).toHaveLength(0)
  })

  it("refuses a provider-attached cancel with no provider callback (BIL-001)", async () => {
    await seedActive()
    const row = store.subscriptions[0]
    row.provider = "STRIPE"
    row.providerSubscriptionId = "sub_123"
    await expectApiError(cancelMySubscription(userId, {}), 502)
    expect(store.subscriptions[0].status).toBe("ACTIVE")
  })

  it("sets cancelAtPeriodEnd without canceling, writes a CANCEL_SCHEDULED event, and repeats idempotently", async () => {
    await seedActive()
    const flagged = await cancelMySubscription(userId, {
      cancelAtPeriodEnd: true,
    })
    expect(flagged.status).toBe("ACTIVE")
    expect(flagged.cancelAtPeriodEnd).toBe(true)
    expect(store.events.filter((e) => e.type === "CANCELED")).toHaveLength(0)
    // DB-045 (Wave 8): a scheduled cancel is a timeline event now.
    expect(
      store.events.filter((e) => e.type === "CANCEL_SCHEDULED")
    ).toHaveLength(1)
    const again = await cancelMySubscription(userId, {
      cancelAtPeriodEnd: true,
    })
    expect(again.cancelAtPeriodEnd).toBe(true)
  })

  it("404s with no subscription at all", async () => {
    await expectApiError(cancelMySubscription(userId, {}), 404)
  })

  it("409s when already canceled", async () => {
    await seedActive()
    await cancelMySubscription(userId, {})
    await expectApiError(cancelMySubscription(userId, {}), 409)
  })
})

describe("getMyUsage (BIL-124 / AIM-014)", () => {
  it("returns the caller's meters + effective entitlements", async () => {
    const usage = await getMyUsage(userId)
    expect(usage.source).toBe("free")
    expect(usage.entitlements).toEqual(FREE_PLAN_V1_ENTITLEMENTS)
    expect(usage.subscription).toBeNull()
    for (const meter of [
      "FORMS",
      "DOMAINS",
      "SUBMISSIONS",
      "API_KEYS",
      "MCP_REQUESTS",
      "AI_REQUESTS",
    ] as const) {
      expect(usage.meters[meter]).toEqual(expect.objectContaining({ used: 0 }))
    }
    // The AI meter carries the plan's daily allowance.
    expect(usage.meters.AI_REQUESTS.limit).toBe(
      (FREE_PLAN_V1_ENTITLEMENTS as { aiRequestsPerDay: number })
        .aiRequestsPerDay
    )
  })

  it("includes the active subscription when one exists", async () => {
    await subscribeToFreePlan(userId, { planVersionId: "pv-free" })
    const usage = await getMyUsage(userId)
    expect(usage.subscription?.planVersionId).toBe("pv-free")
    expect(usage.source).toBe("subscription")
  })
})
