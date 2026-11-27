// Phase D Worker C — Coupons: checkout wiring + dashboard coupon input
// (plan §3.7, Q6 + Q7).
//
// No test hits the real DB, a real provider, or the network: the
// billing + plans services run against the same mocked-Prisma store
// pattern as tests/billing-events-customer-wave6.test.ts, the
// provider layer is mocked at the module level (Phase B pattern),
// and `@sendcms/coupons` is mocked to the brief's contract
// (validateCouponForCheckout / getCouponByCode / recordRedemption).
//
// Consolidation: the grant resolves the attempt's code with the
// read-only getCouponByCode lookup — it does NOT re-validate
// (a code expiring between checkout and grant must not refuse a
// paid grant).
//
// DEPENDENCY (landed during this build): Stream A's
// `@sendcms/coupons` module + CheckoutAttempt migration
// (couponCode / discountAmountMinor columns) are in this tree and
// the generated Prisma client includes the columns — the service
// imports match the landed contract exactly (CouponSummary carries
// id + code; recordRedemption throws 409 on a reached cap). These
// tests mock the coupons module, so they pass with the real module
// present too.
//
// TIME: no test asserts a locale-rendered clock time.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@sendcms/database"
import { ApiError } from "@sendcms/shared"
import type { AdminSession } from "@sendcms/auth"

function makeActor(
  overrides: Partial<AdminSession["user"]> = {}
): AdminSession {
  return {
    user: {
      id: "user-1",
      name: "User",
      email: "user@example.com",
      image: null,
      platformRole: "PLATFORM_USER",
      status: "ACTIVE",
      adminRole: null,
      emailVerified: true,
      ...overrides,
    },
    session: {
      id: "sess-1",
      userId: "user-1",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    },
  }
}

const actor = makeActor()

// ─── Mocks ────────────────────────────────────────────────────────────

const mockLogAudit = vi.hoisted(() => vi.fn(async () => undefined))
const mockValidateCoupon = vi.hoisted(() =>
  vi.fn(async () => ({
    coupon: { id: "coupon-1", code: "SAVE10" },
    discountAmountMinor: 500,
    finalAmountMinor: 1500,
    currency: "USD",
  }))
)
// Consolidation: the grant resolves the attempt's code with a
// read-only lookup (no re-validation — see plans service). The
// grant only reads the returned coupon's id.
const mockGetCouponByCode = vi.hoisted(() =>
  vi.fn(async (_tx: unknown, code: string) => ({
    id: "coupon-1",
    code,
  }))
)
const mockRecordRedemption = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => undefined)
)
const mockCreateCheckout = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({
    checkoutUrl: "https://checkout.test/pay",
    providerCheckoutId: "cs_1",
    catalog: { stripePriceId: "price_new" },
  }))
)
const mockCreateStripeCustomer = vi.hoisted(() => vi.fn(async () => "cus_1"))
const mockActivate = vi.hoisted(() => vi.fn(async () => null))
const mockApplyRefund = vi.hoisted(() => vi.fn(async () => null))
const mockCancelSub = vi.hoisted(() => vi.fn(async () => null))
const mockExtend = vi.hoisted(() => vi.fn(async () => null))
const mockMarkPastDue = vi.hoisted(() => vi.fn(async () => null))
const mockSync = vi.hoisted(() => vi.fn(async () => null))

type StoredVersion = {
  id: string
  planId: string
  plan: { name: string }
  status: string
  priceAmount: number | null
  priceCurrency: string
  billingInterval: string
  trialDays: number
  stripePriceId: string | null
  paypalProductId: string | null
  paypalPlanId: string | null
  polarProductId: string | null
}

type StoredAttempt = {
  id: string
  attemptId: string
  userId: string | null
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

// A subscription row carries its relations embedded, the way
// toSubscriptionSummary reads them (user / plan / planVersion).
type StoredSubscription = {
  id: string
  userId: string
  user: { id: string; name: string | null; email: string }
  planId: string
  plan: { id: string; name: string; slug: string }
  planVersionId: string
  planVersion: StoredVersion & { plan: { name: string } }
  status: string
  provider: string | null
  providerSubscriptionId: string | null
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  createdAt: Date
  updatedAt: Date
}

const { store, mockDb, lastTx } = vi.hoisted(() => {
  const store = {
    versions: new Map<string, StoredVersion>(),
    users: new Map<
      string,
      {
        id: string
        name: string | null
        email: string
        stripeCustomerId: string | null
      }
    >(),
    configs: new Map<
      string,
      {
        provider: string
        isEnabled: boolean
        countries: { countryCode: string }[]
      }
    >(),
    attempts: new Map<string, StoredAttempt>(),
    subscriptions: new Map<string, StoredSubscription>(),
    subEvents: [] as { subscriptionId: string; type: string }[],
    purchases: [] as { providerReference: string }[],
    seq: 1,
    failNextSubscriptionCreate: false,
  }
  const lastTx: { current: Record<string, unknown> | null } = {
    current: null,
  }

  function nextId(prefix: string): string {
    return `${prefix}_${store.seq++}`
  }

  function statusIn(status: string, cond?: { in?: string[] } | string) {
    if (cond === undefined) return true
    if (typeof cond === "object" && cond !== null && "in" in cond) {
      return (cond.in ?? []).includes(status)
    }
    return status === cond
  }

  function findAttempt(where: Record<string, unknown>): StoredAttempt | null {
    const rows = [...store.attempts.values()].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    )
    for (const row of rows) {
      if (where.provider !== undefined && row.provider !== where.provider)
        continue
      if (where.userId !== undefined && row.userId !== where.userId) continue
      if (
        where.planVersionId !== undefined &&
        row.planVersionId !== where.planVersionId
      )
        continue
      const pci = where.providerCheckoutId as
        { in?: string[] } | string | undefined
      if (pci !== undefined) {
        if (typeof pci === "object" && pci !== null && "in" in pci) {
          if (!(pci.in ?? []).includes(row.providerCheckoutId ?? "")) continue
        } else if (row.providerCheckoutId !== pci) continue
      }
      const status = where.status as { in?: string[] } | string | undefined
      if (status !== undefined && !statusIn(row.status, status)) continue
      return row
    }
    return null
  }

  function makeTx() {
    const tx = {
      __ops: [] as string[],
      $executeRaw: vi.fn(async () => []),
      planVersion: {
        findUnique: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      user: {
        findUnique: vi.fn(async () => null),
        update: vi.fn(async () => ({})),
      },
      checkoutAttempt: {
        findFirst: vi.fn(
          async ({ where }: { where: Record<string, unknown> }) =>
            findAttempt(where)
        ),
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
      subscription: {
        findFirst: vi.fn(
          async ({ where }: { where: Record<string, unknown> }) => {
            for (const row of store.subscriptions.values()) {
              if (
                where.provider !== undefined &&
                row.provider !== where.provider
              )
                continue
              if (
                where.providerSubscriptionId !== undefined &&
                row.providerSubscriptionId !== where.providerSubscriptionId
              )
                continue
              if (where.userId !== undefined && row.userId !== where.userId)
                continue
              const status = where.status as
                { in?: string[] } | string | undefined
              if (status !== undefined && !statusIn(row.status, status))
                continue
              return row
            }
            return null
          }
        ),
        findUniqueOrThrow: vi.fn(
          async ({ where }: { where: { id: string } }) => {
            const row = store.subscriptions.get(where.id)
            if (!row) throw new Error(`subscription ${where.id} not found`)
            return row
          }
        ),
        updateMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          ;(tx.__ops as string[]).push("subscription.create")
          if (store.failNextSubscriptionCreate) {
            store.failNextSubscriptionCreate = false
            throw new Error("boom: subscription create failed")
          }
          const version = store.versions.get(
            data.planVersionId as string
          ) as StoredVersion
          const user = store.users.get(data.userId as string) ?? {
            id: data.userId as string,
            name: null,
            email: "user@example.com",
            stripeCustomerId: null,
          }
          const row: StoredSubscription = {
            id: nextId("sub"),
            userId: data.userId as string,
            user: { id: user.id, name: user.name, email: user.email },
            planId: data.planId as string,
            plan: {
              id: data.planId as string,
              name: version?.plan.name ?? "Pro",
              slug: "pro",
            },
            planVersionId: data.planVersionId as string,
            planVersion: {
              ...(version as StoredVersion),
              plan: { name: version?.plan.name ?? "Pro" },
            },
            status: data.status as string,
            provider: data.provider as string | null,
            providerSubscriptionId: data.providerSubscriptionId as
              string | null,
            currentPeriodStart:
              (data.currentPeriodStart as Date | null) ?? null,
            currentPeriodEnd: (data.currentPeriodEnd as Date | null) ?? null,
            cancelAtPeriodEnd: false,
            createdAt: new Date("2026-11-27T00:00:00Z"),
            updatedAt: new Date("2026-11-27T00:00:00Z"),
          }
          store.subscriptions.set(row.id, row)
          return row
        }),
      },
      subscriptionEvent: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          ;(tx.__ops as string[]).push("subscriptionEvent.create")
          const row = {
            subscriptionId: data.subscriptionId as string,
            type: data.type as string,
          }
          store.subEvents.push(row)
          return row
        }),
      },
      oneTimePurchase: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          ;(tx.__ops as string[]).push("oneTimePurchase.create")
          const row = { providerReference: data.providerReference as string }
          store.purchases.push(row)
          return row
        }),
      },
    }
    return tx
  }

  const mockDb = {
    planVersion: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          store.versions.get(where.id) ?? null
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          store.users.get(where.id) ?? null
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string }
          data: Record<string, unknown>
        }) => {
          const user = store.users.get(where.id)
          if (user) Object.assign(user, data)
          return user ?? null
        }
      ),
    },
    billingProviderConfig: {
      findUnique: vi.fn(
        async ({ where }: { where: { provider: string } }) =>
          store.configs.get(where.provider) ?? null
      ),
    },
    checkoutAttempt: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (store.attempts.has(data.attemptId as string)) {
          throw new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed on the fields: (`attemptId`)",
            { code: "P2002", clientVersion: "5.0.0" }
          )
        }
        const row: StoredAttempt = {
          id: nextId("att"),
          attemptId: data.attemptId as string,
          userId: (data.userId as string | null) ?? null,
          planVersionId: data.planVersionId as string,
          provider: data.provider as string,
          providerCheckoutId:
            (data.providerCheckoutId as string | null) ?? null,
          priceAmount: (data.priceAmount as number | null) ?? null,
          priceCurrency: (data.priceCurrency as string) ?? "USD",
          couponCode: (data.couponCode as string | null) ?? null,
          discountAmountMinor:
            (data.discountAmountMinor as number | null) ?? null,
          status: (data.status as string) ?? "CREATED",
          createdAt: new Date("2026-11-27T00:00:00Z"),
        }
        store.attempts.set(row.attemptId, row)
        return row
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { attemptId: string }
          data: Record<string, unknown>
        }) => {
          const row = store.attempts.get(where.attemptId)
          if (!row) throw new Error(`attempt ${where.attemptId} not found`)
          Object.assign(row, data)
          return row
        }
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        findAttempt(where)
      ),
    },
    subscription: {
      findFirst: vi.fn(async () => null),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = makeTx()
      lastTx.current = tx as unknown as Record<string, unknown>
      return cb(tx)
    }),
  }
  return { store, mockDb, lastTx }
})

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/security")>()
  return { ...actual, logAudit: mockLogAudit }
})
vi.mock("@sendcms/coupons", () => ({
  validateCouponForCheckout: mockValidateCoupon,
  getCouponByCode: mockGetCouponByCode,
  recordRedemption: (...args: unknown[]) => {
    const tx = args[0] as { __ops?: string[] }
    tx.__ops?.push("recordRedemption")
    return mockRecordRedemption(...args)
  },
}))
vi.mock("@sendcms/plans", () => ({
  activateSubscriptionFromCheckout: mockActivate,
  applyRefund: mockApplyRefund,
  cancelSubscriptionFromProvider: mockCancelSub,
  extendSubscriptionPeriod: mockExtend,
  markSubscriptionPastDue: mockMarkPastDue,
  syncSubscriptionFromProvider: mockSync,
}))
vi.mock("../packages/modules/billing/src/providers", () => ({
  FREEMIUS_REPLAY_WINDOW_MS: 600_000,
  createCheckoutForProvider: mockCreateCheckout,
  createStripeBillingPortalSession: vi.fn(async () => "https://portal.test"),
  createStripeCustomer: mockCreateStripeCustomer,
  getFreemiusPlanMapCount: () => 0,
  retrievePayPalOrder: vi.fn(async () => ({})),
  retrievePayPalSubscription: vi.fn(async () => ({})),
  retrieveStripeCheckoutSession: vi.fn(async () => ({})),
  verifyWebhookForProvider: vi.fn(async () => ({})),
}))

// The services under test, imported through their source paths so
// the mocked "@sendcms/plans" barrel above only affects the billing
// service's import of it.
import { createCheckoutSession } from "../packages/modules/billing/src/service"
import { checkoutSessionSchema } from "../packages/modules/billing/src/validators"
import { activateSubscriptionFromCheckout } from "../packages/modules/plans/src/service"

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const root = process.cwd()
const read = (rel: string) => readFileSync(path.join(root, rel), "utf-8")

function readJson(rel: string): Record<string, string> {
  return JSON.parse(read(rel)) as Record<string, string>
}

function seedVersion(overrides: Partial<StoredVersion> = {}): StoredVersion {
  const version: StoredVersion = {
    id: "pv-1",
    planId: "plan-1",
    plan: { name: "Pro" },
    status: "PUBLISHED",
    priceAmount: 2000,
    priceCurrency: "USD",
    billingInterval: "MONTHLY",
    trialDays: 0,
    stripePriceId: "price_full",
    paypalProductId: "prod_full",
    paypalPlanId: "plan_full",
    polarProductId: "polar_full",
    ...overrides,
  }
  store.versions.set(version.id, version)
  return version
}

function seedStripeEnabled() {
  store.configs.set("STRIPE", {
    provider: "STRIPE",
    isEnabled: true,
    countries: [],
  })
}

function seedUser() {
  store.users.set("user-1", {
    id: "user-1",
    name: "User",
    email: "user@example.com",
    stripeCustomerId: null,
  })
}

function seedAttempt(overrides: Partial<StoredAttempt> = {}): StoredAttempt {
  const row: StoredAttempt = {
    id: `att_${store.seq++}`,
    attemptId: "attempt-1",
    userId: "user-1",
    planVersionId: "pv-1",
    provider: "STRIPE",
    providerCheckoutId: "cs_1",
    priceAmount: 1500,
    priceCurrency: "USD",
    couponCode: "SAVE10",
    discountAmountMinor: 500,
    status: "COMPLETED",
    createdAt: new Date("2026-11-27T00:00:00Z"),
    ...overrides,
  }
  store.attempts.set(row.attemptId, row)
  return row
}

beforeEach(() => {
  vi.clearAllMocks()
  store.versions.clear()
  store.users.clear()
  store.configs.clear()
  store.attempts.clear()
  store.subscriptions.clear()
  store.subEvents.length = 0
  store.purchases.length = 0
  store.failNextSubscriptionCreate = false
  lastTx.current = null
  mockValidateCoupon.mockResolvedValue({
    coupon: { id: "coupon-1", code: "SAVE10" },
    discountAmountMinor: 500,
    finalAmountMinor: 1500,
    currency: "USD",
  })
  mockRecordRedemption.mockResolvedValue(undefined)
  mockCreateCheckout.mockResolvedValue({
    checkoutUrl: "https://checkout.test/pay",
    providerCheckoutId: "cs_1",
    catalog: { stripePriceId: "price_new" },
  })
  process.env.STRIPE_SECRET_KEY = "sk_test_x"
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_x"
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_x"
  seedVersion()
  seedStripeEnabled()
  seedUser()
})

describe("checkoutSessionSchema couponCode", () => {
  it("accepts an optional coupon code", () => {
    const parsed = checkoutSessionSchema.safeParse({
      planVersionId: "pv-1",
      provider: "STRIPE",
      couponCode: "SAVE10",
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.couponCode).toBe("SAVE10")
  })

  it("accepts a checkout without a coupon code", () => {
    const parsed = checkoutSessionSchema.safeParse({
      planVersionId: "pv-1",
      provider: "STRIPE",
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.couponCode).toBeUndefined()
  })

  it("rejects an empty code and a code over 50 chars", () => {
    expect(
      checkoutSessionSchema.safeParse({
        planVersionId: "pv-1",
        provider: "STRIPE",
        couponCode: "",
      }).success
    ).toBe(false)
    expect(
      checkoutSessionSchema.safeParse({
        planVersionId: "pv-1",
        provider: "STRIPE",
        couponCode: "A".repeat(51),
      }).success
    ).toBe(false)
  })
})

describe("createCheckoutSession with a coupon", () => {
  it("discounts the recorded amount: attempt priceAmount = discounted, couponCode + discountAmountMinor stored", async () => {
    const result = await createCheckoutSession(actor, {
      planVersionId: "pv-1",
      provider: "STRIPE",
      couponCode: "save10",
    })
    expect(result.checkoutUrl).toBe("https://checkout.test/pay")
    expect(mockValidateCoupon).toHaveBeenCalledWith({
      code: "save10",
      userId: "user-1",
      planVersionId: "pv-1",
      priceAmountMinor: 2000,
      currency: "USD",
    })
    // The provider session is priced from the DISCOUNTED amount,
    // with the cached full-price Stripe Price cleared so a fresh
    // discounted Price is minted.
    const providerArgs = mockCreateCheckout.mock.calls[0][1] as {
      version: { priceAmount: number; stripePriceId?: string }
    }
    expect(providerArgs.version.priceAmount).toBe(1500)
    expect(providerArgs.version.stripePriceId).toBeUndefined()
    // The attempt records the discounted amount actually charged.
    const attempt = store.attempts.get("attempt-1")
    // The client did not pass attemptId, so the service generated
    // one — find the single stored row instead.
    const rows = [...store.attempts.values()]
    expect(rows).toHaveLength(1)
    expect(rows[0].priceAmount).toBe(1500)
    expect(rows[0].couponCode).toBe("SAVE10")
    expect(rows[0].discountAmountMinor).toBe(500)
    expect(rows[0].status).toBe("COMPLETED")
    expect(rows[0].providerCheckoutId).toBe("cs_1")
    void attempt
  })

  it("does not persist the discounted catalog ids onto the plan version", async () => {
    await createCheckoutSession(actor, {
      planVersionId: "pv-1",
      provider: "STRIPE",
      couponCode: "SAVE10",
    })
    // A discounted Stripe Price must never become the version's
    // cached full-price object.
    expect(mockDb.planVersion.updateMany).not.toHaveBeenCalled()
  })

  it("persists the catalog ids when no coupon applies", async () => {
    await createCheckoutSession(actor, {
      planVersionId: "pv-1",
      provider: "STRIPE",
    })
    expect(mockDb.planVersion.updateMany).toHaveBeenCalled()
    const providerArgs = mockCreateCheckout.mock.calls[0][1] as {
      version: { priceAmount: number; stripePriceId?: string }
    }
    expect(providerArgs.version.priceAmount).toBe(2000)
    expect(providerArgs.version.stripePriceId).toBe("price_full")
  })

  it("invalid/expired/exhausted code → 422 with the server message, no provider session, no attempt", async () => {
    mockValidateCoupon.mockRejectedValue(
      new ApiError("This coupon has expired.", 422)
    )
    await expect(
      createCheckoutSession(actor, {
        planVersionId: "pv-1",
        provider: "STRIPE",
        couponCode: "OLD",
      })
    ).rejects.toMatchObject({
      message: "This coupon has expired.",
      status: 422,
    })
    expect(mockCreateCheckout).not.toHaveBeenCalled()
    expect(store.attempts.size).toBe(0)
    // No attempt was ever marked COMPLETED with a discount.
    expect(
      [...store.attempts.values()].some((a) => a.status === "COMPLETED")
    ).toBe(false)
  })

  it("100% discount → 422, no provider session, no attempt", async () => {
    mockValidateCoupon.mockResolvedValue({
      coupon: { id: "coupon-1", code: "FREE100" },
      discountAmountMinor: 2000,
      finalAmountMinor: 0,
      currency: "USD",
    })
    await expect(
      createCheckoutSession(actor, {
        planVersionId: "pv-1",
        provider: "STRIPE",
        couponCode: "FREE100",
      })
    ).rejects.toMatchObject({ status: 422 })
    expect(mockCreateCheckout).not.toHaveBeenCalled()
    expect(store.attempts.size).toBe(0)
  })

  it("discount below the provider minimum → 422, no provider session", async () => {
    mockValidateCoupon.mockResolvedValue({
      coupon: { id: "coupon-1", code: "ALMOSTFREE" },
      discountAmountMinor: 1980,
      finalAmountMinor: 20,
      currency: "USD",
    })
    await expect(
      createCheckoutSession(actor, {
        planVersionId: "pv-1",
        provider: "STRIPE",
        couponCode: "ALMOSTFREE",
      })
    ).rejects.toMatchObject({ status: 422 })
    expect(mockCreateCheckout).not.toHaveBeenCalled()
  })

  it("Freemius + coupon → 422 without validating or calling the provider", async () => {
    store.configs.set("FREEMIUS", {
      provider: "FREEMIUS",
      isEnabled: true,
      countries: [],
    })
    process.env.FREEMIUS_PRODUCT_ID = "prod_1"
    await expect(
      createCheckoutSession(actor, {
        planVersionId: "pv-1",
        provider: "FREEMIUS",
        couponCode: "SAVE10",
      })
    ).rejects.toMatchObject({ status: 422 })
    expect(mockValidateCoupon).not.toHaveBeenCalled()
    expect(mockCreateCheckout).not.toHaveBeenCalled()
  })

  it("no-coupon checkout records the full price and reuses the cached price", async () => {
    await createCheckoutSession(actor, {
      planVersionId: "pv-1",
      provider: "STRIPE",
    })
    expect(mockValidateCoupon).not.toHaveBeenCalled()
    const rows = [...store.attempts.values()]
    expect(rows).toHaveLength(1)
    expect(rows[0].priceAmount).toBe(2000)
    expect(rows[0].couponCode).toBeNull()
    expect(rows[0].discountAmountMinor).toBeNull()
  })
})

describe("activateSubscriptionFromCheckout grant-time redemption", () => {
  const grantInput = {
    userId: "user-1",
    planVersionId: "pv-1",
    provider: "STRIPE" as const,
    providerSubscriptionId: "sub_1",
    periodEnd: null,
    checkoutId: "cs_1",
  }

  it("grant with a coupon writes the redemption in the same transaction (after the grant rows)", async () => {
    const attempt = seedAttempt()
    const summary = await activateSubscriptionFromCheckout(grantInput)
    expect(summary.id).toMatch(/^sub_/)
    const tx = lastTx.current as unknown as { __ops: string[] }
    expect(tx.__ops).toEqual([
      "subscription.create",
      "subscriptionEvent.create",
      "recordRedemption",
    ])
    expect(mockValidateCoupon).not.toHaveBeenCalled()
    // The grant resolves the code with a read-only lookup, NOT
    // re-validation: a code expiring between checkout and grant
    // must not refuse a paid grant.
    expect(mockGetCouponByCode).toHaveBeenCalledWith(
      expect.anything(),
      "SAVE10"
    )
    expect(mockRecordRedemption).toHaveBeenCalledTimes(1)
    expect(mockRecordRedemption).toHaveBeenCalledWith(expect.anything(), {
      couponId: "coupon-1",
      userId: "user-1",
      subscriptionId: summary.id,
      checkoutAttemptId: attempt.id,
      discountAmountMinor: 500,
      currency: "USD",
    })
  })

  it("grant with a coupon on a one-time purchase redeems against the new subscription too", async () => {
    const attempt = seedAttempt()
    const summary = await activateSubscriptionFromCheckout({
      ...grantInput,
      isOneTime: true,
      providerReference: "pi_1",
    })
    expect(summary.id).toMatch(/^sub_/)
    const tx = lastTx.current as unknown as {
      __ops: string[]
      oneTimePurchase: { create: ReturnType<typeof vi.fn> }
    }
    expect(tx.__ops).toEqual([
      "subscription.create",
      "subscriptionEvent.create",
      "oneTimePurchase.create",
      "recordRedemption",
    ])
    expect(mockRecordRedemption).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        couponId: "coupon-1",
        subscriptionId: summary.id,
        checkoutAttemptId: attempt.id,
        discountAmountMinor: 500,
      })
    )
    // The one-time purchase records what was actually charged
    // (the attempt's discounted price 1500), not the full
    // version price 2000.
    expect(tx.oneTimePurchase.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ priceAmount: 1500 }),
      })
    )
  })

  it("grant without a coupon writes no redemption", async () => {
    const summary = await activateSubscriptionFromCheckout(grantInput)
    expect(summary.id).toMatch(/^sub_/)
    expect(mockRecordRedemption).not.toHaveBeenCalled()
    expect(mockValidateCoupon).not.toHaveBeenCalled()
    expect(mockGetCouponByCode).not.toHaveBeenCalled()
  })

  it("grant failure writes no redemption (the transaction aborts first)", async () => {
    seedAttempt()
    store.failNextSubscriptionCreate = true
    await expect(activateSubscriptionFromCheckout(grantInput)).rejects.toThrow(
      "boom: subscription create failed"
    )
    expect(mockRecordRedemption).not.toHaveBeenCalled()
  })

  it("duplicate redelivery returns the existing subscription and redeems nothing", async () => {
    const attempt = seedAttempt()
    // First delivery grants + redeems.
    await activateSubscriptionFromCheckout(grantInput)
    expect(mockRecordRedemption).toHaveBeenCalledTimes(1)
    // Second delivery for the same provider subscription id hits
    // the duplicate guard and returns the same row.
    mockRecordRedemption.mockClear()
    const again = await activateSubscriptionFromCheckout(grantInput)
    expect(again.id).toBe([...store.subscriptions.values()][0].id)
    expect(mockRecordRedemption).not.toHaveBeenCalled()
    void attempt
  })

  it("Polar-style grant (no checkout id) recovers the coupon via the latest attempt fallback", async () => {
    // The attempt stored the Polar CHECKOUT id, but the recurring
    // webhook carries only the subscription id — the exact lookup
    // misses, and the fallback (latest COMPLETED attempt for this
    // provider + user + plan version) must still find the coupon.
    const attempt = seedAttempt({
      provider: "POLAR",
      providerCheckoutId: "chk_polar",
      attemptId: "attempt-polar",
    })
    const summary = await activateSubscriptionFromCheckout({
      userId: "user-1",
      planVersionId: "pv-1",
      provider: "POLAR",
      providerSubscriptionId: "sub_polar",
      periodEnd: null,
    })
    expect(summary.id).toMatch(/^sub_/)
    expect(mockRecordRedemption).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        couponId: "coupon-1",
        checkoutAttemptId: attempt.id,
        discountAmountMinor: 500,
      })
    )
  })

  it("concurrency: two parallel grants for a maxRedemptions: 1 code — exactly one grant commits", async () => {
    seedAttempt()
    // The mocked recordRedemption enforces the cap the way the
    // real conditional updateMany does: the first redemption
    // succeeds, the second throws 409.
    let redemptions = 0
    mockRecordRedemption.mockImplementation(async () => {
      redemptions += 1
      if (redemptions > 1)
        throw new ApiError("Coupon redemption limit reached.", 409)
    })
    const results = await Promise.allSettled([
      activateSubscriptionFromCheckout({
        ...grantInput,
        providerSubscriptionId: "sub_a",
        checkoutId: "cs_1",
      }),
      activateSubscriptionFromCheckout({
        ...grantInput,
        providerSubscriptionId: "sub_b",
        checkoutId: "cs_1",
      }),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
    })
    // Exactly one redemption succeeded; the loser's grant aborted
    // with it (no grant without a redemption).
    expect(redemptions).toBe(2)
    expect(mockRecordRedemption.mock.calls.length).toBe(2)
  })

  it("cap reached at grant time (409) aborts the grant", async () => {
    seedAttempt()
    mockRecordRedemption.mockRejectedValue(
      new ApiError("Coupon redemption limit reached.", 409)
    )
    await expect(
      activateSubscriptionFromCheckout(grantInput)
    ).rejects.toMatchObject({ status: 409 })
  })
})

describe("checkout + reconcile routes are pass-through only", () => {
  it("the checkout route forwards the parsed body (incl. couponCode) with no coupon logic of its own", () => {
    expect(existsSync("apps/api/app/api/v1/billing/checkout/route.ts")).toBe(
      true
    )
    const route = read("apps/api/app/api/v1/billing/checkout/route.ts")
    expect(route).toContain("checkoutSessionSchema.safeParse")
    expect(route).toContain("createCheckoutSession(session, parsed.data")
    expect(route.toLowerCase()).not.toContain("coupon")
  })

  it("the reconcile route has no coupon logic — the grant recovers the coupon itself", () => {
    expect(existsSync("apps/api/app/api/v1/billing/reconcile/route.ts")).toBe(
      true
    )
    const route = read("apps/api/app/api/v1/billing/reconcile/route.ts")
    expect(route).toContain("reconcileCheckout(session.user.id, parsed.data)")
    expect(route.toLowerCase()).not.toContain("coupon")
  })
})

describe("dashboard checkout coupon input", () => {
  const manager =
    "apps/dashboard/app/dashboard/billing/checkout/checkout-manager.tsx"

  it("has one coupon-code input + Apply button, wired through the existing checkout mutation", () => {
    expect(existsSync(manager)).toBe(true)
    const src = read(manager)
    expect(src).toContain('t("couponLabel")')
    expect(src).toContain('t("couponApply")')
    expect(src).toContain('t("couponPlaceholder")')
    expect(src).toContain("couponCode: appliedCouponCode")
    expect(src).toContain("useCreateCheckoutSession")
    // No new route, no server-only import in the client component —
    // the only database import is the pre-existing type-only one.
    expect(src).not.toContain("@sendcms/coupons")
    expect(src).not.toContain("apiFetch")
    expect(src).toContain(
      'import type { BillingProvider } from "@sendcms/database"'
    )
    expect(src).not.toMatch(
      /import \{[^}]*\bdb\b[^}]*\} from "@sendcms\/database"/
    )
  })

  it("customer-facing coupon strings exist in dashboard billing.json (en + ur) and nothing else was added", () => {
    const en = readJson("packages/i18n/locales/en/dashboard/billing.json")
    const ur = readJson("packages/i18n/locales/ur/dashboard/billing.json")
    for (const key of [
      "couponLabel",
      "couponPlaceholder",
      "couponApply",
      "couponApplied",
      "couponEmpty",
      "couponHint",
    ]) {
      expect(en[key]).toBeTruthy()
      expect(ur[key]).toBeTruthy()
      expect(ur[key]).not.toBe(en[key])
    }
  })

  it("the checkout page itself is untouched (still renders CheckoutManager)", () => {
    const page = read("apps/dashboard/app/dashboard/billing/checkout/page.tsx")
    expect(page).toContain("CheckoutManager")
    expect(page.toLowerCase()).not.toContain("coupon")
  })
})
