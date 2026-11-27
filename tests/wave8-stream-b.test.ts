// SendCMS Phase 16, Wave 8 — Stream B (billing providers:
// webhooks, checkout, geo, reconciliation).
//
// The REAL billing service + plans service run against a stateful
// in-memory fake DB — only the database, the audit writer, and the
// provider SDKs are stubbed. No test hits the real DB, a real
// provider, or the network (PayPal's fetch is stubbed).
// Stripe/Polar/Freemius webhook signatures are computed for real
// (HMAC / Standard Webhooks), so the verification paths are
// genuinely exercised; the Stripe/Polar/Freemius SDK clients are
// stubbed, with the real Stripe/Polar webhook verifiers kept.
import { createHmac } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AdminSession } from "@sendcms/auth"
import { Prisma } from "@sendcms/database"
import {
  createBillingPortalSession,
  createCheckoutSession,
  handleWebhook,
  listBillingEvents,
  listCheckoutAttempts,
  listEnabledProviders,
  listProviderConfigs,
  reconcileCheckout,
  verifyCheckoutReturn,
} from "@sendcms/billing"
import { countryFromHeaders } from "@sendcms/billing"
import { addMonthsClamped, addYearsClamped, periodEndFor } from "@sendcms/plans"
import {
  billingEventKindFor,
  currencyExponent,
  isPolarCurrencySupported,
  isValidCurrencyCode,
  priceAsDecimal,
  priceInMinorUnits,
  providerMinimumStoredUnits,
  validatePriceForCheckout,
} from "../packages/modules/billing/src/providers/types"
import { STRIPE_API_VERSION } from "../packages/modules/billing/src/providers/stripe"

function makeSession(
  overrides: Partial<AdminSession["user"]> = {}
): AdminSession {
  return {
    user: {
      id: "user-1",
      name: "Test User",
      email: "user@example.com",
      image: null,
      platformRole: "PLATFORM_USER",
      status: "ACTIVE",
      adminRole: null,
      emailVerified: true,
      ...overrides,
    },
    session: { id: "sess-1", userId: "user-1", expiresAt: new Date() },
  }
}

const customerSession = makeSession()
const ownerSession = makeSession({
  id: "admin-1",
  email: "admin@csofts.com",
  platformRole: "PLATFORM_OWNER",
})

const mockLogAudit = vi.hoisted(() => vi.fn(async () => undefined))

// ─── Provider SDK stubs ──────────────────────────────────────────────

const mockStripePricesCreate = vi.hoisted(() =>
  vi.fn(async () => ({ id: "price_test_1" }))
)
const mockStripeCheckoutCreate = vi.hoisted(() =>
  vi.fn(async () => ({
    id: "cs_test_1",
    url: "https://checkout.stripe.test/pay/cs_test_1",
  }))
)
const stripeSessionStub = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}))
const mockStripeCheckoutRetrieve = vi.hoisted(() =>
  vi.fn(async () => stripeSessionStub.current)
)
const mockStripeCustomersCreate = vi.hoisted(() =>
  vi.fn(async () => ({ id: "cus_test_1" }))
)
const mockStripePortalCreate = vi.hoisted(() =>
  vi.fn(async () => ({ url: "https://billing.stripe.test/portal" }))
)

vi.mock("stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("stripe")>()
  const RealStripe = actual.default
  class MockStripe {
    prices = { create: mockStripePricesCreate }
    checkout = {
      sessions: {
        create: mockStripeCheckoutCreate,
        retrieve: mockStripeCheckoutRetrieve,
      },
    }
    customers = { create: mockStripeCustomersCreate }
    billingPortal = { sessions: { create: mockStripePortalCreate } }
    // The real verifier — signatures are checked for real.
    webhooks = new RealStripe("sk_test_x", {
      apiVersion: "2026-11-18.endive",
    }).webhooks
  }
  return { ...actual, default: MockStripe }
})

const mockPolarProductsCreate = vi.hoisted(() =>
  vi.fn(async () => ({ id: "prod_polar_1" }))
)
const mockPolarCheckoutsCreate = vi.hoisted(() =>
  vi.fn(async () => ({
    id: "co_polar_1",
    url: "https://checkout.polar.test/co_polar_1",
  }))
)

vi.mock("@polar-sh/sdk/2026-10", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@polar-sh/sdk/2026-10")>()
  return {
    ...actual,
    createPolar: () => ({
      products: { create: mockPolarProductsCreate },
      checkouts: { create: mockPolarCheckoutsCreate },
    }),
  }
})

const freemiusStub = vi.hoisted(() => ({
  createArgs: null as Record<string, unknown> | null,
  cancelButton: null as string | null,
  link: "https://checkout.freemius.test/abc",
  pricingPlans: [] as unknown[],
}))
const mockFreemiusCheckoutCreate = vi.hoisted(() =>
  vi.fn(async (args: Record<string, unknown>) => {
    freemiusStub.createArgs = args
    return {
      setCancelButton: (url: string) => {
        freemiusStub.cancelButton = url
      },
      getLink: () => freemiusStub.link,
    }
  })
)
const mockFreemiusPricing = vi.hoisted(() =>
  vi.fn(async () => ({ plans: freemiusStub.pricingPlans }))
)

vi.mock("@freemius/sdk", () => {
  class MockFreemius {
    api = { product: { retrievePricingData: mockFreemiusPricing } }
    checkout = { create: mockFreemiusCheckoutCreate }
    constructor() {}
  }
  return { Freemius: MockFreemius }
})

// ─── Fake DB ─────────────────────────────────────────────────────────

const { store, mockDb } = vi.hoisted(() => {
  type StoredUser = {
    id: string
    name: string | null
    email: string
    stripeCustomerId: string | null
  }
  type StoredVersion = {
    id: string
    planId: string
    version: number
    status: string
    priceAmount: number | null
    priceCurrency: string
    billingInterval: string
    trialDays: number
    entitlements: Record<string, unknown>
    stripePriceId: string | null
    paypalProductId: string | null
    paypalPlanId: string | null
    polarProductId: string | null
  }
  type StoredPlan = {
    id: string
    name: string
    slug: string
    status: string
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
  type StoredSubEvent = {
    id: string
    subscriptionId: string
    type: string
    fromPlanVersionId: string | null
    toPlanVersionId: string | null
    adminId: string | null
    reason: string | null
    providerEventId?: string | null
  }
  type StoredPurchase = {
    id: string
    userId: string
    planId: string
    planVersionId: string
    subscriptionId: string | null
    provider: string
    providerReference: string
    checkoutId: string | null
    priceAmount: number | null
    priceCurrency: string
    accessStart: Date
    accessEnd: Date
    status: string
  }
  type StoredEvent = {
    id: string
    provider: string
    providerEventId: string
    eventType: string
    kind?: string | null
    userId: string | null
    processedAt: Date | null
    createdAt: Date
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
    status: string
    createdAt: Date
    updatedAt: Date
  }
  type StoredConfig = {
    id: string
    provider: string
    isEnabled: boolean
    countries: string[]
  }

  const store = {
    configs: new Map<string, StoredConfig>(),
    countries: [
      { code: "US", name: "United States" },
      { code: "GB", name: "United Kingdom" },
      { code: "AU", name: "Australia" },
      { code: "DE", name: "Germany" },
      { code: "PK", name: "Pakistan" },
      { code: "AE", name: "United Arab Emirates" },
    ],
    events: new Map<string, StoredEvent>(),
    attempts: new Map<string, StoredAttempt>(),
    versions: new Map<string, StoredVersion>(),
    plans: [] as StoredPlan[],
    users: new Map<string, StoredUser>(),
    subscriptions: new Map<string, StoredSub>(),
    subscriptionEvents: [] as StoredSubEvent[],
    purchases: [] as StoredPurchase[],
    eventSeq: 1,
    subSeq: 1,
    attemptSeq: 1,
  }

  function p2002() {
    return new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "test" }
    )
  }

  function matchesWhere(
    row: Record<string, unknown>,
    where: Record<string, unknown> | undefined
  ): boolean {
    if (!where) return true
    return Object.entries(where).every(([key, cond]) => {
      const value = row[key]
      if (cond === null) return value === null || value === undefined
      if (typeof cond === "object" && cond !== null) {
        const c = cond as Record<string, unknown>
        if (Array.isArray(c.in)) {
          return (c.in as unknown[]).includes(value)
        }
        if (c.not !== undefined) {
          if (c.not === null) return value !== null
          return value !== c.not
        }
        return false
      }
      return value === cond
    })
  }

  function enrichSub(row: StoredSub) {
    const version = store.versions.get(row.planVersionId)
    const plan = store.plans.find((p) => p.id === row.planId) ?? {
      id: row.planId,
      name: "Pro",
      slug: "pro",
      status: "PUBLISHED",
    }
    const user = store.users.get(row.userId) ?? {
      id: row.userId,
      name: null,
      email: "user@example.com",
    }
    return {
      ...row,
      user: { id: user.id, name: user.name, email: user.email },
      plan: { id: plan.id, name: plan.name, slug: plan.slug },
      planVersion: version
        ? { ...version, plan: { name: plan.name } }
        : {
            id: row.planVersionId,
            planId: row.planId,
            version: 1,
            status: "PUBLISHED",
            priceAmount: null,
            priceCurrency: "USD",
            billingInterval: "MONTHLY",
            trialDays: 0,
            entitlements: {},
            plan: { name: plan.name },
          },
    }
  }

  function sortedSubs(rows: StoredSub[]) {
    return [...rows].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    )
  }

  const mockDb = {
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(mockDb)),
    $executeRaw: vi.fn(async () => []),
    $queryRaw: vi.fn(async () => []),
    billingProviderConfig: {
      findMany: vi.fn(
        async ({ where }: { where?: { isEnabled?: boolean } } = {}) => {
          const rows = [...store.configs.values()].filter(
            (c) =>
              where?.isEnabled === undefined || c.isEnabled === where.isEnabled
          )
          return rows.map((c) => ({
            ...c,
            countries: c.countries.map((code) => ({ countryCode: code })),
          }))
        }
      ),
      findUnique: vi.fn(async ({ where }: { where: { provider: string } }) => {
        const row = store.configs.get(where.provider)
        if (!row) return null
        return {
          ...row,
          countries: row.countries.map((code) => ({ countryCode: code })),
        }
      }),
    },
    country: {
      findMany: vi.fn(async () => store.countries),
    },
    billingEvent: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            provider_providerEventId: {
              provider: string
              providerEventId: string
            }
          }
        }) =>
          store.events.get(
            `${where.provider_providerEventId.provider}:${where.provider_providerEventId.providerEventId}`
          ) ?? null
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const key = `${data.provider}:${data.providerEventId}`
        if (store.events.has(key)) throw p2002()
        const row: StoredEvent = {
          id: `evt-${store.eventSeq++}`,
          provider: data.provider as string,
          providerEventId: data.providerEventId as string,
          eventType: data.eventType as string,
          kind: (data.kind as string | undefined) ?? null,
          userId: (data.userId as string | null) ?? null,
          processedAt: null,
          createdAt: new Date(),
        }
        store.events.set(key, row)
        return row
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string }
          data: Record<string, unknown>
        }) => {
          const row = [...store.events.values()].find((e) => e.id === where.id)
          if (!row) throw new Error("event not found")
          Object.assign(row, data)
          return row
        }
      ),
      count: vi.fn(
        async ({ where }: { where?: Record<string, unknown> } = {}) => {
          return [...store.events.values()].filter((e) =>
            matchesWhere(e as unknown as Record<string, unknown>, where)
          ).length
        }
      ),
      findMany: vi.fn(
        async ({
          where,
          skip,
          take,
        }: {
          where?: Record<string, unknown>
          skip?: number
          take?: number
        } = {}) => {
          const rows = [...store.events.values()]
            .filter((e) =>
              matchesWhere(e as unknown as Record<string, unknown>, where)
            )
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          return rows.slice(skip ?? 0, (skip ?? 0) + (take ?? rows.length))
        }
      ),
    },
    planVersion: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = store.versions.get(where.id)
        if (!row) return null
        const plan = store.plans.find((p) => p.id === row.planId)
        return { ...row, plan: { name: plan?.name ?? "Pro" } }
      }),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where?: { planId?: string }
        } = {}) => {
          const rows = [...store.versions.values()].filter(
            (v) => !where?.planId || v.planId === where.planId
          )
          rows.sort((a, b) => b.version - a.version)
          return rows[0] ?? null
        }
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>
          data: Record<string, unknown>
        }) => {
          let count = 0
          for (const row of store.versions.values()) {
            if (
              matchesWhere(row as unknown as Record<string, unknown>, where)
            ) {
              Object.assign(row, data)
              count++
            }
          }
          return { count }
        }
      ),
    },
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { id?: string; email?: string } }) => {
          if (where.id) return store.users.get(where.id) ?? null
          if (where.email) {
            return (
              [...store.users.values()].find((u) => u.email === where.email) ??
              null
            )
          }
          return null
        }
      ),
      findFirst: vi.fn(async ({ where }: { where: { email?: string } }) => {
        if (!where.email) return null
        return (
          [...store.users.values()].find((u) => u.email === where.email) ?? null
        )
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string }
          data: Record<string, unknown>
        }) => {
          const row = store.users.get(where.id)
          if (!row) throw new Error("user not found")
          Object.assign(row, data)
          return row
        }
      ),
    },
    subscription: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where?: Record<string, unknown>
        } = {}) => {
          const rows = sortedSubs([...store.subscriptions.values()]).filter(
            (s) => matchesWhere(s as unknown as Record<string, unknown>, where)
          )
          const row = rows[0]
          return row ? enrichSub(row) : null
        }
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = store.subscriptions.get(where.id)
        if (!row) throw new Error("subscription not found")
        return enrichSub(row)
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: StoredSub = {
          id: `sub-${store.subSeq++}`,
          userId: data.userId as string,
          planId: data.planId as string,
          planVersionId: data.planVersionId as string,
          status: data.status as string,
          currentPeriodStart: (data.currentPeriodStart as Date | null) ?? null,
          currentPeriodEnd: (data.currentPeriodEnd as Date | null) ?? null,
          cancelAtPeriodEnd: (data.cancelAtPeriodEnd as boolean) ?? false,
          provider: (data.provider as string | null) ?? null,
          providerSubscriptionId:
            (data.providerSubscriptionId as string | null) ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        store.subscriptions.set(row.id, row)
        return enrichSub(row)
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string }
          data: Record<string, unknown>
        }) => {
          const row = store.subscriptions.get(where.id)
          if (!row) throw new Error("subscription not found")
          Object.assign(row, data, { updatedAt: new Date() })
          return enrichSub(row)
        }
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>
          data: Record<string, unknown>
        }) => {
          let count = 0
          for (const row of store.subscriptions.values()) {
            if (
              matchesWhere(row as unknown as Record<string, unknown>, where)
            ) {
              Object.assign(row, data, { updatedAt: new Date() })
              count++
            }
          }
          return { count }
        }
      ),
    },
    subscriptionEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: StoredSubEvent = {
          id: `se-${store.subscriptionEvents.length + 1}`,
          subscriptionId: data.subscriptionId as string,
          type: data.type as string,
          fromPlanVersionId: (data.fromPlanVersionId as string | null) ?? null,
          toPlanVersionId: (data.toPlanVersionId as string | null) ?? null,
          adminId: (data.adminId as string | null) ?? null,
          reason: (data.reason as string | null) ?? null,
          providerEventId: (data.providerEventId as string | null) ?? null,
        }
        store.subscriptionEvents.push(row)
        return row
      }),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          return (
            store.subscriptionEvents.find((e) =>
              matchesWhere(e as unknown as Record<string, unknown>, where)
            ) ?? null
          )
        }
      ),
    },
    oneTimePurchase: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const dup = store.purchases.find(
          (p) =>
            p.provider === data.provider &&
            p.providerReference === data.providerReference
        )
        if (dup) throw p2002()
        const row: StoredPurchase = {
          id: `otp-${store.purchases.length + 1}`,
          userId: data.userId as string,
          planId: data.planId as string,
          planVersionId: data.planVersionId as string,
          subscriptionId: (data.subscriptionId as string | null) ?? null,
          provider: data.provider as string,
          providerReference: data.providerReference as string,
          checkoutId: (data.checkoutId as string | null) ?? null,
          priceAmount: (data.priceAmount as number | null) ?? null,
          priceCurrency: data.priceCurrency as string,
          accessStart: data.accessStart as Date,
          accessEnd: data.accessEnd as Date,
          status: data.status as string,
        }
        store.purchases.push(row)
        return row
      }),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          return (
            store.purchases.find((p) =>
              matchesWhere(p as unknown as Record<string, unknown>, where)
            ) ?? null
          )
        }
      ),
    },
    checkoutAttempt: {
      // Phase D (Coupons): the grant-time redemption lookup reads the
      // attempt inside the transaction; default "no attempt" — none
      // of these tests seeds a coupon attempt.
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (store.attempts.has(data.attemptId as string)) throw p2002()
        const row: StoredAttempt = {
          id: `att-${store.attemptSeq++}`,
          attemptId: data.attemptId as string,
          userId: (data.userId as string | null) ?? null,
          planVersionId: data.planVersionId as string,
          provider: data.provider as string,
          providerCheckoutId:
            (data.providerCheckoutId as string | null) ?? null,
          priceAmount: (data.priceAmount as number | null) ?? null,
          priceCurrency: data.priceCurrency as string,
          status: data.status as string,
          createdAt: new Date(),
          updatedAt: new Date(),
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
          if (!row) throw new Error("attempt not found")
          Object.assign(row, data, { updatedAt: new Date() })
          return row
        }
      ),
      count: vi.fn(
        async ({ where }: { where?: Record<string, unknown> } = {}) => {
          return [...store.attempts.values()].filter((a) =>
            matchesWhere(a as unknown as Record<string, unknown>, where)
          ).length
        }
      ),
      findMany: vi.fn(
        async ({
          where,
          skip,
          take,
        }: {
          where?: Record<string, unknown>
          skip?: number
          take?: number
        } = {}) => {
          const rows = [...store.attempts.values()]
            .filter((a) =>
              matchesWhere(a as unknown as Record<string, unknown>, where)
            )
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          return rows.slice(skip ?? 0, (skip ?? 0) + (take ?? rows.length))
        }
      ),
    },
  }

  return { store, mockDb }
})

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", () => ({ logAudit: mockLogAudit }))

// ─── Seeds + env ─────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {}

function setEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function seedUser(overrides: Record<string, unknown> = {}) {
  const user = {
    id: "user-1",
    name: "Test User",
    email: "user@example.com",
    stripeCustomerId: null,
    ...overrides,
  } as {
    id: string
    name: string | null
    email: string
    stripeCustomerId: string | null
  }
  store.users.set(user.id, user)
  return user
}

function seedPlan() {
  if (!store.plans.find((p) => p.id === "plan-1")) {
    store.plans.push({
      id: "plan-1",
      name: "Pro",
      slug: "pro",
      status: "PUBLISHED",
    })
  }
}

function seedVersion(overrides: Record<string, unknown> = {}) {
  seedPlan()
  const version = {
    id: "pv-1",
    planId: "plan-1",
    version: 1,
    status: "PUBLISHED",
    priceAmount: 9900,
    priceCurrency: "USD",
    billingInterval: "MONTHLY",
    trialDays: 0,
    entitlements: {},
    stripePriceId: null,
    paypalProductId: null,
    paypalPlanId: null,
    polarProductId: null,
    ...overrides,
  }
  store.versions.set(version.id as string, version)
  return version
}

function seedConfig(
  provider: string,
  isEnabled: boolean,
  countries: string[] = []
) {
  store.configs.set(provider, {
    id: `cfg-${provider}`,
    provider,
    isEnabled,
    countries,
  })
}

function seedSubscription(overrides: Record<string, unknown> = {}) {
  const row = {
    id: `sub-seed-${store.subSeq++}`,
    userId: "user-1",
    planId: "plan-1",
    planVersionId: "pv-1",
    status: "ACTIVE",
    currentPeriodStart: new Date("2026-11-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-12-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
    provider: "STRIPE",
    providerSubscriptionId: "sub_test",
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  } as Parameters<typeof store.subscriptions.set>[1]
  store.subscriptions.set(row.id, row)
  return row
}

function stripeEnv() {
  setEnv({
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_PUBLISHABLE_KEY: "pk_test_x",
    STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
  })
}

function paypalEnv() {
  setEnv({
    PAYPAL_CLIENT_ID: "id",
    PAYPAL_CLIENT_SECRET: "secret",
    PAYPAL_WEBHOOK_ID: "wh_123",
  })
}

function polarEnv() {
  setEnv({
    POLAR_ACCESS_TOKEN: "polar_test_token",
    POLAR_WEBHOOK_SECRET: "whsec_polar_test_secret",
  })
}

function freemiusEnv() {
  setEnv({
    FREEMIUS_PRODUCT_ID: "123",
    FREEMIUS_API_KEY: "key",
    FREEMIUS_SECRET_KEY: "secret",
    FREEMIUS_PUBLIC_KEY: "public",
    FREEMIUS_PLAN_MAP: JSON.stringify({ "pv-1": "plan_1" }),
  })
}

beforeEach(() => {
  store.configs.clear()
  store.events.clear()
  store.attempts.clear()
  store.versions.clear()
  store.plans.length = 0
  store.users.clear()
  store.subscriptions.clear()
  store.subscriptionEvents.length = 0
  store.purchases.length = 0
  stripeSessionStub.current = null
  freemiusStub.createArgs = null
  freemiusStub.cancelButton = null
  freemiusStub.pricingPlans = []
  vi.clearAllMocks()
  seedUser()
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key]
})

describe("currency helpers (BIL-011 / BIL-056)", () => {
  const usd = {
    id: "pv-1",
    planId: "plan-1",
    planName: "Pro",
    priceAmount: 1000,
    priceCurrency: "USD",
    billingInterval: "MONTHLY" as const,
    trialDays: 0,
  }
  const jpy = { ...usd, priceAmount: 100000, priceCurrency: "JPY" }

  it("treats JPY as zero-decimal: 100000 stored -> 1000 minor units, '1000' decimal", () => {
    expect(currencyExponent("JPY")).toBe(0)
    expect(currencyExponent("USD")).toBe(2)
    expect(priceInMinorUnits(jpy)).toBe(1000)
    expect(priceAsDecimal(jpy)).toBe("1000")
    expect(priceInMinorUnits(usd)).toBe(1000)
    expect(priceAsDecimal(usd)).toBe("10.00")
  })

  it("rejects an invalid currency code (case-insensitive: 'usd' is well-formed)", () => {
    expect(isValidCurrencyCode("USD")).toBe(true)
    expect(isValidCurrencyCode("usd")).toBe(true)
    expect(isValidCurrencyCode("XX1")).toBe(false)
    expect(isValidCurrencyCode("US")).toBe(false)
    expect(validatePriceForCheckout({ ...usd, priceCurrency: "XX1" })).toMatch(
      /Invalid price currency/
    )
  })

  it("rejects a zero-decimal price that is not a whole number of yen", () => {
    expect(validatePriceForCheckout({ ...jpy, priceAmount: 100050 })).toMatch(
      /whole number of JPY|multiple of 100/i
    )
    expect(validatePriceForCheckout(jpy)).toBeNull()
  })

  it("rejects an unknown currency for Polar, accepts USD/JPY", () => {
    expect(isPolarCurrencySupported("XXX")).toBe(false)
    expect(isPolarCurrencySupported("USD")).toBe(true)
    expect(isPolarCurrencySupported("jpy")).toBe(true)
  })

  it("enforces provider minimums (BIL-027): $0.10 USD and ¥50 JPY are below minimum", () => {
    expect(providerMinimumStoredUnits("USD")).toBe(50)
    expect(providerMinimumStoredUnits("GBP")).toBe(30)
    expect(providerMinimumStoredUnits("JPY")).toBe(5000)
    expect(validatePriceForCheckout({ ...usd, priceAmount: 10 })).toMatch(
      /minimum/i
    )
    expect(validatePriceForCheckout({ ...usd, priceAmount: 50 })).toBeNull()
    expect(validatePriceForCheckout({ ...jpy, priceAmount: 4900 })).toMatch(
      /minimum/i
    )
    expect(validatePriceForCheckout({ ...jpy, priceAmount: 5000 })).toBeNull()
  })

  it("lets a free version pass validation", () => {
    expect(validatePriceForCheckout({ ...usd, priceAmount: null })).toBeNull()
    expect(validatePriceForCheckout({ ...usd, priceAmount: 0 })).toBeNull()
  })
})

describe("geo detection (BIL-126 / BIL-130)", () => {
  it("returns null for Vercel XX and T1, the country for real codes", () => {
    expect(
      countryFromHeaders(new Headers({ "x-vercel-ip-country": "XX" }))
    ).toBeNull()
    expect(
      countryFromHeaders(new Headers({ "x-vercel-ip-country": "T1" }))
    ).toBeNull()
    expect(
      countryFromHeaders(new Headers({ "x-vercel-ip-country": "pk" }))
    ).toBe("PK")
    expect(
      countryFromHeaders(new Headers({ "x-vercel-ip-country": "US" }))
    ).toBe("US")
  })

  it("returns null for Cloudflare XX/T1, the country otherwise", () => {
    expect(countryFromHeaders(new Headers({ "cf-ipcountry": "XX" }))).toBeNull()
    expect(countryFromHeaders(new Headers({ "cf-ipcountry": "T1" }))).toBeNull()
    expect(countryFromHeaders(new Headers({ "cf-ipcountry": "de" }))).toBe("DE")
  })

  it("returns null when no geo header is present, Vercel wins over Cloudflare", () => {
    expect(countryFromHeaders(new Headers())).toBeNull()
    expect(
      countryFromHeaders(
        new Headers({
          "x-vercel-ip-country": "PK",
          "cf-ipcountry": "US",
        })
      )
    ).toBe("PK")
  })
})

describe("period arithmetic (BIL-099)", () => {
  it("clamps end-of-month starts: 31 Jan + 1 month -> 28 Feb", () => {
    const start = new Date("2026-01-31T10:00:00.000Z")
    expect(addMonthsClamped(start, 1).toISOString()).toBe(
      "2026-02-28T10:00:00.000Z"
    )
  })

  it("clamps leap-day years: 29 Feb 2024 + 1 year -> 28 Feb 2025", () => {
    expect(
      addYearsClamped(new Date("2024-02-29T10:00:00.000Z"), 1).toISOString()
    ).toBe("2025-02-28T10:00:00.000Z")
  })

  it("periodEndFor uses clamped arithmetic for MONTHLY/ANNUAL", () => {
    expect(
      periodEndFor(
        "MONTHLY",
        new Date("2026-01-31T10:00:00.000Z")
      )?.toISOString()
    ).toBe("2026-02-28T10:00:00.000Z")
    expect(
      periodEndFor(
        "ANNUAL",
        new Date("2024-02-29T10:00:00.000Z")
      )?.toISOString()
    ).toBe("2025-02-28T10:00:00.000Z")
    expect(periodEndFor("ONE_TIME", new Date())).toBeNull()
  })
})

describe("webhook kind mapping + pinned Stripe version (BIL-012 / DB-015)", () => {
  it("pins the Stripe API version", () => {
    expect(STRIPE_API_VERSION).toBe("2026-11-18.endive")
  })

  it("maps every normalized kind to a BillingEventKind, unmapped-payment included", () => {
    expect(billingEventKindFor({ kind: "checkout-completed" } as never)).toBe(
      "CHECKOUT_COMPLETED"
    )
    expect(billingEventKindFor({ kind: "payment-succeeded" } as never)).toBe(
      "PAYMENT_SUCCEEDED"
    )
    expect(billingEventKindFor({ kind: "payment-failed" } as never)).toBe(
      "PAYMENT_FAILED"
    )
    expect(
      billingEventKindFor({ kind: "subscription-canceled" } as never)
    ).toBe("SUBSCRIPTION_CANCELED")
    expect(billingEventKindFor({ kind: "subscription-updated" } as never)).toBe(
      "SUBSCRIPTION_UPDATED"
    )
    expect(billingEventKindFor({ kind: "payment-refunded" } as never)).toBe(
      "PAYMENT_REFUNDED"
    )
    expect(billingEventKindFor({ kind: "unmapped-payment" } as never)).toBe(
      "UNMAPPED_PAYMENT"
    )
    expect(billingEventKindFor({ kind: "ignored" } as never)).toBe("IGNORED")
    expect(billingEventKindFor({ kind: "freemius-checkout" } as never)).toBe(
      "CHECKOUT_COMPLETED"
    )
  })
})

describe("checkout — Stripe customer, price reuse, attempts (BIL-017 / BIL-027 / BIL-028 / SRC-222)", () => {
  beforeEach(() => {
    stripeEnv()
    seedVersion()
    seedConfig("STRIPE", true, [])
  })

  it("creates one Stripe customer, stores it, and reuses it on the next checkout", async () => {
    const first = await createCheckoutSession(customerSession, {
      planVersionId: "pv-1",
      provider: "STRIPE",
    })
    expect(first.checkoutUrl).toBe("https://checkout.stripe.test/pay/cs_test_1")
    expect(mockStripeCustomersCreate).toHaveBeenCalledTimes(1)
    expect(mockStripeCustomersCreate).toHaveBeenCalledWith({
      email: "user@example.com",
      name: "Test User",
    })
    expect(store.users.get("user-1")?.stripeCustomerId).toBe("cus_test_1")

    const second = await createCheckoutSession(customerSession, {
      planVersionId: "pv-1",
      provider: "STRIPE",
    })
    expect(second.checkoutUrl).toBe(
      "https://checkout.stripe.test/pay/cs_test_1"
    )
    // No second customer — the stored id is reused.
    expect(mockStripeCustomersCreate).toHaveBeenCalledTimes(1)
    expect(mockStripeCheckoutCreate).toHaveBeenCalledTimes(2)
    expect(mockStripeCheckoutCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ customer: "cus_test_1" }),
      expect.anything()
    )
  })

  it("creates the Stripe Price once and reuses it (SRC-222)", async () => {
    await createCheckoutSession(customerSession, {
      planVersionId: "pv-1",
      provider: "STRIPE",
    })
    expect(mockStripePricesCreate).toHaveBeenCalledTimes(1)
    expect(store.versions.get("pv-1")?.stripePriceId).toBe("price_test_1")

    await createCheckoutSession(customerSession, {
      planVersionId: "pv-1",
      provider: "STRIPE",
    })
    expect(mockStripePricesCreate).toHaveBeenCalledTimes(1)
    // The second checkout passed the cached price id.
    expect(mockStripeCheckoutCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        line_items: [{ price: "price_test_1", quantity: 1 }],
      }),
      expect.anything()
    )
  })

  it("records exactly one attempt row, COMPLETED with the provider checkout id", async () => {
    const result = await createCheckoutSession(customerSession, {
      planVersionId: "pv-1",
      provider: "STRIPE",
    })
    expect(result.attemptId).toBeTruthy()
    expect(result.providerCheckoutId).toBe("cs_test_1")
    const attempts = [...store.attempts.values()]
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      attemptId: result.attemptId,
      userId: "user-1",
      planVersionId: "pv-1",
      provider: "STRIPE",
      providerCheckoutId: "cs_test_1",
      priceAmount: 9900,
      priceCurrency: "USD",
      status: "COMPLETED",
    })
    const page = await listCheckoutAttempts(ownerSession, {
      page: 1,
      perPage: 20,
    })
    expect(page.total).toBe(1)
    expect(page.attempts[0]?.attemptId).toBe(result.attemptId)
  })

  it("marks the attempt FAILED when the provider call throws", async () => {
    mockStripeCheckoutCreate.mockRejectedValueOnce(new Error("stripe down"))
    await expect(
      createCheckoutSession(customerSession, {
        planVersionId: "pv-1",
        provider: "STRIPE",
      })
    ).rejects.toThrow("stripe down")
    const attempts = [...store.attempts.values()]
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.status).toBe("FAILED")
  })

  it("refuses a below-minimum price with a named 422 (BIL-027)", async () => {
    seedVersion({ priceAmount: 10 })
    await expect(
      createCheckoutSession(customerSession, {
        planVersionId: "pv-1",
        provider: "STRIPE",
      })
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("minimum"),
    })
    expect(mockStripeCheckoutCreate).not.toHaveBeenCalled()
  })

  it("refuses a JPY price that is not a whole number of yen (BIL-011)", async () => {
    seedVersion({ priceAmount: 100050, priceCurrency: "JPY" })
    await expect(
      createCheckoutSession(customerSession, {
        planVersionId: "pv-1",
        provider: "STRIPE",
      })
    ).rejects.toMatchObject({ status: 422 })
    expect(mockStripeCheckoutCreate).not.toHaveBeenCalled()
  })

  it("refuses an invalid currency code (DB-015)", async () => {
    seedVersion({ priceAmount: 9900, priceCurrency: "XX1" })
    await expect(
      createCheckoutSession(customerSession, {
        planVersionId: "pv-1",
        provider: "STRIPE",
      })
    ).rejects.toMatchObject({ status: 422 })
  })
})

describe("checkout — Polar + Freemius + Gumroad (BIL-048 / BIL-050 / BIL-056 / BIL-057 / BIL-095)", () => {
  it("passes return_url and customer_ip_address to Polar, and reuses the cached product", async () => {
    polarEnv()
    seedVersion()
    seedConfig("POLAR", true, [])
    const result = await createCheckoutSession(
      customerSession,
      { planVersionId: "pv-1", provider: "POLAR" },
      { clientIpAddress: "203.0.113.7" }
    )
    expect(result.checkoutUrl).toBe("https://checkout.polar.test/co_polar_1")
    expect(mockPolarProductsCreate).toHaveBeenCalledTimes(1)
    expect(mockPolarCheckoutsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        return_url: expect.stringContaining("/dashboard/billing/checkout"),
      })
    )
    expect(mockPolarCheckoutsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        return_url: expect.stringContaining("cancelled=1"),
        customer_ip_address: "203.0.113.7",
      })
    )
    expect(store.versions.get("pv-1")?.polarProductId).toBe("prod_polar_1")

    await createCheckoutSession(customerSession, {
      planVersionId: "pv-1",
      provider: "POLAR",
    })
    expect(mockPolarProductsCreate).toHaveBeenCalledTimes(1)
  })

  it("refuses an unsupported Polar currency with a 422 (BIL-056)", async () => {
    polarEnv()
    seedVersion({ priceCurrency: "XXX" })
    seedConfig("POLAR", true, [])
    await expect(
      createCheckoutSession(customerSession, {
        planVersionId: "pv-1",
        provider: "POLAR",
      })
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("not supported by Polar"),
    })
    expect(mockPolarCheckoutsCreate).not.toHaveBeenCalled()
  })

  it("creates a Freemius sandbox checkout with the cancel button wired (BIL-048 / BIL-050)", async () => {
    freemiusEnv()
    seedVersion()
    seedConfig("FREEMIUS", true, [])
    const result = await createCheckoutSession(customerSession, {
      planVersionId: "pv-1",
      provider: "FREEMIUS",
    })
    expect(result.checkoutUrl).toBe("https://checkout.freemius.test/abc")
    // Sandbox ON in the test env (NODE_ENV=test, no FREEMIUS_SANDBOX flag).
    expect(freemiusStub.createArgs?.isSandbox).toBe(true)
    expect(freemiusStub.cancelButton).toContain("/dashboard/billing/checkout")
    expect(freemiusStub.cancelButton).toContain("cancelled=1")
  })

  it("creates a Freemius production checkout when FREEMIUS_SANDBOX=false", async () => {
    freemiusEnv()
    setEnv({ FREEMIUS_SANDBOX: "false", NODE_ENV: "production" })
    seedVersion()
    seedConfig("FREEMIUS", true, [])
    await createCheckoutSession(customerSession, {
      planVersionId: "pv-1",
      provider: "FREEMIUS",
    })
    expect(freemiusStub.createArgs?.isSandbox).toBe(false)
  })

  it("never lists Gumroad to customers, and the admin row carries the manual-activation note (BIL-095)", async () => {
    setEnv({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_PUBLISHABLE_KEY: "pk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      GUMROAD_APP_ID: "app",
      GUMROAD_APP_SECRET: "secret",
    })
    seedConfig("STRIPE", true, [])
    seedConfig("GUMROAD", true, ["PK"])
    expect((await listEnabledProviders("PK")).map((p) => p.provider)).toEqual([
      "STRIPE",
    ])
    const rows = await listProviderConfigs(ownerSession)
    const gumroad = rows.find((r) => r.provider === "GUMROAD")
    expect(gumroad?.checkoutImplemented).toBe(false)
    expect(gumroad?.note).toMatch(/manual activation/i)
    expect(gumroad?.note).toMatch(/Admin → Subscriptions → Assign/)
  })

  it("refuses Gumroad checkout with a typed 422 (BIL-055/095)", async () => {
    setEnv({ GUMROAD_APP_ID: "app", GUMROAD_APP_SECRET: "secret" })
    seedVersion()
    seedConfig("GUMROAD", true, [])
    await expect(
      createCheckoutSession(customerSession, {
        planVersionId: "pv-1",
        provider: "GUMROAD",
      })
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("not available for Gumroad"),
    })
  })
})

describe("webhook 503s for unconfigured providers (BIL-101)", () => {
  it("Stripe without a webhook secret returns 503, not 422", async () => {
    setEnv({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: undefined,
    })
    await expect(
      handleWebhook("STRIPE", "{}", { "stripe-signature": "t=1,v1=x" })
    ).rejects.toMatchObject({ status: 503 })
  })

  it("PayPal without a webhook id returns 503", async () => {
    setEnv({
      PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: "secret",
      PAYPAL_WEBHOOK_ID: undefined,
    })
    await expect(handleWebhook("PAYPAL", "{}", {})).rejects.toMatchObject({
      status: 503,
    })
  })

  it("Polar without a webhook secret returns 503", async () => {
    setEnv({ POLAR_ACCESS_TOKEN: "tok", POLAR_WEBHOOK_SECRET: undefined })
    await expect(handleWebhook("POLAR", "{}", {})).rejects.toMatchObject({
      status: 503,
    })
  })

  it("Freemius without a secret returns 503", async () => {
    setEnv({ FREEMIUS_SECRET_KEY: undefined })
    await expect(handleWebhook("FREEMIUS", "{}", {})).rejects.toMatchObject({
      status: 503,
    })
  })
})

describe("Stripe webhooks — trial, renewal, cancel (BIL-049 / BIL-096 / BIL-023 / BIL-026)", () => {
  function stripeSignature(payload: string): string {
    const ts = Math.floor(Date.now() / 1000)
    const v1 = createHmac("sha256", "whsec_test_secret")
      .update(`${ts}.${payload}`)
      .digest("hex")
    return `t=${ts},v1=${v1}`
  }

  function checkoutSessionPayload(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      id: "evt_checkout_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_1",
          mode: "subscription",
          subscription: "sub_trial_1",
          payment_intent: "pi_test_1",
          metadata: { userId: "user-1", planVersionId: "pv-1" },
          ...overrides,
        },
      },
    })
  }

  beforeEach(() => {
    stripeEnv()
    seedVersion()
  })

  it("activates a trial checkout as TRIALING ending now + trialDays (BIL-096)", async () => {
    seedVersion({ trialDays: 7 })
    const before = Date.now()
    const payload = checkoutSessionPayload()
    const result = await handleWebhook("STRIPE", payload, {
      "stripe-signature": stripeSignature(payload),
    })
    expect(result).toMatchObject({ received: true, kind: "checkout-completed" })
    const subs = [...store.subscriptions.values()]
    expect(subs).toHaveLength(1)
    expect(subs[0]?.status).toBe("TRIALING")
    const end = subs[0]?.currentPeriodEnd?.getTime() ?? 0
    expect(end).toBeGreaterThan(before + 6 * 24 * 60 * 60 * 1000)
    expect(end).toBeLessThanOrEqual(before + 7 * 24 * 60 * 60 * 1000 + 60_000)
    // The event row carries the normalized kind (DB-015).
    const event = store.events.get("STRIPE:evt_checkout_1")
    expect(event?.kind).toBe("CHECKOUT_COMPLETED")
    expect(event?.processedAt).not.toBeNull()
  })

  it("activates a non-trial checkout as ACTIVE with the monthly period", async () => {
    const payload = checkoutSessionPayload()
    await handleWebhook("STRIPE", payload, {
      "stripe-signature": stripeSignature(payload),
    })
    const subs = [...store.subscriptions.values()]
    expect(subs).toHaveLength(1)
    expect(subs[0]?.status).toBe("ACTIVE")
  })

  it("extends from the subscription's own invoice line, not the first line (BIL-026)", async () => {
    seedSubscription({ providerSubscriptionId: "sub_test" })
    const wrongEnd = Math.floor(Date.parse("2026-02-01T00:00:00Z") / 1000)
    const rightEnd = Math.floor(Date.parse("2027-01-01T00:00:00Z") / 1000)
    const payload = JSON.stringify({
      id: "evt_invoice_1",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_test_1",
          subscription: "sub_test",
          lines: {
            data: [
              {
                id: "li_other",
                subscription: "sub_other",
                period: {
                  start: 1767225600,
                  end: wrongEnd, // must NOT be used
                },
              },
              {
                id: "li_mine",
                subscription: "sub_test",
                period: {
                  start: 1767225600,
                  end: rightEnd,
                },
              },
            ],
          },
        },
      },
    })
    const result = await handleWebhook("STRIPE", payload, {
      "stripe-signature": stripeSignature(payload),
    })
    expect(result).toMatchObject({ received: true, kind: "payment-succeeded" })
    const sub = [...store.subscriptions.values()][0]
    expect(sub?.status).toBe("ACTIVE")
    expect(sub?.currentPeriodEnd?.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z"
    )
    expect(store.events.get("STRIPE:evt_invoice_1")?.processedAt).not.toBeNull()
  })

  it("leaves a lineless invoice unprocessed as unmapped-payment (BIL-026 / BIL-100)", async () => {
    seedSubscription({ providerSubscriptionId: "sub_test" })
    const payload = JSON.stringify({
      id: "evt_invoice_2",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_test_2",
          subscription: "sub_test",
          lines: { data: [] },
        },
      },
    })
    const result = await handleWebhook("STRIPE", payload, {
      "stripe-signature": stripeSignature(payload),
    })
    expect(result).toMatchObject({
      received: true,
      kind: "unmapped-payment",
    })
    const event = store.events.get("STRIPE:evt_invoice_2")
    expect(event?.kind).toBe("UNMAPPED_PAYMENT")
    expect(event?.processedAt).toBeNull()
    // No extension happened.
    const sub = [...store.subscriptions.values()][0]
    expect(sub?.currentPeriodEnd?.toISOString()).toBe(
      "2026-12-01T00:00:00.000Z"
    )
    // The unprocessed row is visible in the admin list (the queue).
    const unprocessed = await listBillingEvents(ownerSession, {
      page: 1,
      perPage: 20,
      processed: false,
    })
    expect(unprocessed.events.map((e) => e.providerEventId)).toContain(
      "evt_invoice_2"
    )
  })

  it("leaves a checkout with missing metadata unprocessed as unmapped-payment (BIL-100)", async () => {
    const payload = JSON.stringify({
      id: "evt_checkout_2",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_2",
          mode: "subscription",
          subscription: "sub_nomd",
          metadata: {},
        },
      },
    })
    const result = await handleWebhook("STRIPE", payload, {
      "stripe-signature": stripeSignature(payload),
    })
    expect(result).toMatchObject({
      received: true,
      kind: "unmapped-payment",
    })
    expect(store.events.get("STRIPE:evt_checkout_2")?.processedAt).toBeNull()
    expect(store.subscriptions.size).toBe(0)
  })

  it("leaves a renewal for an unknown subscription unprocessed (BIL-016)", async () => {
    const payload = JSON.stringify({
      id: "evt_invoice_3",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_test_3",
          subscription: "sub_unknown",
          lines: {
            data: [
              {
                id: "li_1",
                parent: {
                  subscription_item_details: {
                    subscription: "sub_unknown",
                  },
                },
                period: { start: 1767225600, end: 1790000000 },
              },
            ],
          },
        },
      },
    })
    const result = await handleWebhook("STRIPE", payload, {
      "stripe-signature": stripeSignature(payload),
    })
    expect(result).toMatchObject({ received: true, kind: "payment-succeeded" })
    expect(store.events.get("STRIPE:evt_invoice_3")?.processedAt).toBeNull()
  })

  it("cancels on customer.subscription.deleted (BIL-023)", async () => {
    seedSubscription({ providerSubscriptionId: "sub_test" })
    const payload = JSON.stringify({
      id: "evt_sub_del",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_test" } },
    })
    const result = await handleWebhook("STRIPE", payload, {
      "stripe-signature": stripeSignature(payload),
    })
    expect(result).toMatchObject({
      received: true,
      kind: "subscription-canceled",
    })
    expect([...store.subscriptions.values()][0]?.status).toBe("CANCELED")
    expect(store.events.get("STRIPE:evt_sub_del")?.processedAt).not.toBeNull()
  })

  it("syncs cancel_at_period_end from customer.subscription.updated (BIL-094)", async () => {
    seedSubscription({ providerSubscriptionId: "sub_test" })
    const payload = JSON.stringify({
      id: "evt_sub_upd",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_test",
          status: "active",
          cancel_at_period_end: true,
          // SDK v23 / API 2026-11-18: Subscription has no top-level
          // `current_period_end` — the period lives on the items.
          items: { data: [{ current_period_end: 1790000000 }] },
        },
      },
    })
    const result = await handleWebhook("STRIPE", payload, {
      "stripe-signature": stripeSignature(payload),
    })
    expect(result).toMatchObject({
      received: true,
      kind: "subscription-updated",
    })
    const sub = [...store.subscriptions.values()][0]
    expect(sub?.cancelAtPeriodEnd).toBe(true)
    expect(sub?.currentPeriodEnd?.toISOString()).toBe(
      new Date(1790000000 * 1000).toISOString()
    )
  })

  it("flips a trial to ACTIVE on the first invoice.paid (BIL-049)", async () => {
    seedVersion({ trialDays: 7 })
    const checkout = checkoutSessionPayload()
    await handleWebhook("STRIPE", checkout, {
      "stripe-signature": stripeSignature(checkout),
    })
    expect([...store.subscriptions.values()][0]?.status).toBe("TRIALING")
    const invoice = JSON.stringify({
      id: "evt_invoice_trial",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_trial",
          subscription: "sub_trial_1",
          lines: {
            data: [
              {
                id: "li_1",
                subscription: "sub_trial_1",
                period: {
                  start: 1767225600,
                  end: Math.floor(Date.parse("2027-01-01T00:00:00Z") / 1000),
                },
              },
            ],
          },
        },
      },
    })
    await handleWebhook("STRIPE", invoice, {
      "stripe-signature": stripeSignature(invoice),
    })
    const sub = [...store.subscriptions.values()][0]
    expect(sub?.status).toBe("ACTIVE")
    expect(sub?.currentPeriodEnd?.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z"
    )
  })
})

describe("PayPal webhooks (BIL-094 / BIL-023)", () => {
  function paypalFetchStub(
    handlers: (url: string) => Record<string, unknown> | null
  ) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/oauth2/token")) {
          return {
            ok: true,
            json: async () => ({ access_token: "tok" }),
          }
        }
        if (url.includes("/v1/notifications/verify-webhook-signature")) {
          return {
            ok: true,
            json: async () => ({ verification_status: "SUCCESS" }),
          }
        }
        const body = handlers(url)
        if (body) return { ok: true, json: async () => body }
        return { ok: false, status: 404, json: async () => ({}) }
      })
    )
  }

  function paypalHeaders() {
    return {
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.paypal.com/cert",
      "paypal-transmission-id": "tx-1",
      "paypal-transmission-sig": "sig",
      "paypal-transmission-time": new Date().toISOString(),
    }
  }

  beforeEach(() => {
    paypalEnv()
    seedVersion()
    paypalFetchStub(() => null)
  })

  it("maps SUSPENDED to PAST_DUE and CANCELLED to canceled (BIL-094)", async () => {
    seedSubscription({
      provider: "PAYPAL",
      providerSubscriptionId: "I-TESTSUB",
    })
    const suspended = JSON.stringify({
      id: "evt_pp_1",
      event_type: "BILLING.SUBSCRIPTION.SUSPENDED",
      resource: { id: "I-TESTSUB" },
    })
    const result = await handleWebhook("PAYPAL", suspended, paypalHeaders())
    expect(result).toMatchObject({ received: true, kind: "payment-failed" })
    expect([...store.subscriptions.values()][0]?.status).toBe("PAST_DUE")

    const cancelled = JSON.stringify({
      id: "evt_pp_2",
      event_type: "BILLING.SUBSCRIPTION.CANCELLED",
      resource: { id: "I-TESTSUB" },
    })
    const result2 = await handleWebhook("PAYPAL", cancelled, paypalHeaders())
    expect(result2).toMatchObject({
      received: true,
      kind: "subscription-canceled",
    })
    expect([...store.subscriptions.values()][0]?.status).toBe("CANCELED")
  })

  it("activates a one-time capture and extends a subscription capture (BIL-023)", async () => {
    const capture = JSON.stringify({
      id: "evt_pp_3",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "cap_1",
        custom_id: "user-1:pv-1",
        supplementary_data: { related_ids: { order_id: "order_1" } },
      },
    })
    const result = await handleWebhook("PAYPAL", capture, paypalHeaders())
    expect(result).toMatchObject({
      received: true,
      kind: "checkout-completed",
    })
    expect([...store.subscriptions.values()]).toHaveLength(1)
    expect([...store.subscriptions.values()][0]?.provider).toBe("PAYPAL")
    // A capture is a one-time payment (BIL-003): the separate
    // purchase record is written alongside the subscription.
    expect(store.purchases).toHaveLength(1)
    expect(store.purchases[0]?.providerReference).toBe("cap_1")
  })
})

describe("Polar webhooks (BIL-094 / BIL-097 / BIL-130)", () => {
  const secret = "whsec_polar_test_secret"

  function polarHeaders(id: string, payload: string) {
    const ts = String(Math.floor(Date.now() / 1000))
    const signature = `v1,${createHmac("sha256", secret)
      .update(`${id}.${ts}.${payload}`)
      .digest("base64")}`
    return {
      "webhook-id": id,
      "webhook-timestamp": ts,
      "webhook-signature": signature,
    }
  }

  beforeEach(() => {
    polarEnv()
    seedVersion()
  })

  it("verifies a signed subscription.updated and syncs cancel_at_period_end", async () => {
    seedSubscription({
      provider: "POLAR",
      providerSubscriptionId: "sub_polar_1",
    })
    const payload = JSON.stringify({
      type: "subscription.updated",
      timestamp: new Date().toISOString(),
      api_version: "2026-10",
      data: {
        id: "sub_polar_1",
        status: "active",
        current_period_end: "2027-01-01T00:00:00Z",
        cancel_at_period_end: true,
      },
    })
    const result = await handleWebhook(
      "POLAR",
      payload,
      polarHeaders("msg_polar_upd", payload)
    )
    expect(result).toMatchObject({
      received: true,
      kind: "subscription-updated",
    })
    const sub = [...store.subscriptions.values()][0]
    expect(sub?.cancelAtPeriodEnd).toBe(true)
    expect(sub?.currentPeriodEnd?.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z"
    )
  })

  it("rejects a bad Polar signature with 401", async () => {
    const payload = JSON.stringify({
      type: "subscription.updated",
      timestamp: new Date().toISOString(),
      api_version: "2026-10",
      data: { id: "sub_polar_1", status: "active" },
    })
    await expect(
      handleWebhook("POLAR", payload, {
        "webhook-id": "msg_bad",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      })
    ).rejects.toMatchObject({ status: 401 })
  })
})

describe("Freemius webhooks (BIL-093)", () => {
  // The signing secret must match FREEMIUS_SECRET_KEY (freemiusEnv
  // sets it to "secret").
  const secret = "secret"

  function freemiusHeaders(payload: string) {
    return {
      "x-signature": createHmac("sha256", secret).update(payload).digest("hex"),
    }
  }

  function licensePayload(
    type: string,
    data: Record<string, unknown>,
    id = "evt_fs_1"
  ) {
    return JSON.stringify({
      id,
      type,
      objects: {
        license: { id: "lic_1", plan_id: "plan_1" },
        user: { email: "buyer@example.com" },
      },
      data,
    })
  }

  beforeEach(() => {
    setEnv({ FREEMIUS_SECRET_KEY: secret })
    freemiusEnv()
    seedVersion()
    // The Freemius buyer resolves by email in the service.
    store.users.set("buyer-1", {
      id: "buyer-1",
      name: "Buyer",
      email: "buyer@example.com",
      stripeCustomerId: null,
    })
  })

  it("activates on license.created with the buyer email", async () => {
    const payload = licensePayload("license.created", {
      expiration: "2027-01-01T00:00:00Z",
    })
    const result = await handleWebhook(
      "FREEMIUS",
      payload,
      freemiusHeaders(payload)
    )
    expect(result).toMatchObject({
      received: true,
      kind: "freemius-checkout",
    })
    const subs = [...store.subscriptions.values()]
    expect(subs).toHaveLength(1)
    expect(subs[0]?.userId).toBe("buyer-1")
    expect(subs[0]?.provider).toBe("FREEMIUS")
  })

  it("shortens the period on license.shortened (BIL-093 / BIL-094)", async () => {
    seedSubscription({
      provider: "FREEMIUS",
      providerSubscriptionId: "lic_1",
      currentPeriodEnd: new Date("2027-06-01T00:00:00Z"),
    })
    const payload = licensePayload(
      "license.shortened",
      { to: "2026-12-15T00:00:00Z" },
      "evt_fs_short"
    )
    const result = await handleWebhook(
      "FREEMIUS",
      payload,
      freemiusHeaders(payload)
    )
    expect(result).toMatchObject({
      received: true,
      kind: "subscription-updated",
    })
    expect(
      [...store.subscriptions.values()][0]?.currentPeriodEnd?.toISOString()
    ).toBe("2026-12-15T00:00:00.000Z")
  })

  it("cancels on license.expired and marks PAST_DUE on renewal failure", async () => {
    seedSubscription({
      provider: "FREEMIUS",
      providerSubscriptionId: "lic_1",
    })
    const failed = licensePayload(
      "subscription.renewal.failed",
      {},
      "evt_fs_fail"
    )
    const r1 = await handleWebhook("FREEMIUS", failed, freemiusHeaders(failed))
    expect(r1).toMatchObject({ received: true, kind: "payment-failed" })
    expect([...store.subscriptions.values()][0]?.status).toBe("PAST_DUE")

    const expired = licensePayload("license.expired", {}, "evt_fs_exp")
    const r2 = await handleWebhook(
      "FREEMIUS",
      expired,
      freemiusHeaders(expired)
    )
    expect(r2).toMatchObject({
      received: true,
      kind: "subscription-canceled",
    })
    expect([...store.subscriptions.values()][0]?.status).toBe("CANCELED")
  })
})

describe("checkout return verification + reconciliation (BIL-015 / BIL-016 / BIL-052)", () => {
  function stubPayPalFetch(
    handler: (url: string) => Record<string, unknown> | null
  ) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/oauth2/token")) {
          return { ok: true, json: async () => ({ access_token: "tok" }) }
        }
        if (url.includes("/v1/notifications/verify-webhook-signature")) {
          return {
            ok: true,
            json: async () => ({ verification_status: "SUCCESS" }),
          }
        }
        const body = handler(url)
        if (body) return { ok: true, json: async () => body }
        return { ok: false, status: 404, json: async () => ({}) }
      })
    )
  }

  function paidStripeSession(overrides: Record<string, unknown> = {}) {
    return {
      id: "cs_test_1",
      payment_status: "paid",
      status: "complete",
      mode: "subscription",
      subscription: "sub_test",
      payment_intent: "pi_1",
      metadata: { userId: "user-1", planVersionId: "pv-1" },
      ...overrides,
    }
  }

  beforeEach(() => {
    seedVersion()
  })

  it("Stripe success URL carries the session id placeholder (BIL-015)", async () => {
    stripeEnv()
    seedConfig("STRIPE", true, [])
    await createCheckoutSession(customerSession, {
      planVersionId: "pv-1",
      provider: "STRIPE",
    })
    expect(mockStripeCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: expect.stringContaining(
          "session_id={CHECKOUT_SESSION_ID}"
        ),
      }),
      expect.anything()
    )
  })

  it("verifies a paid Stripe session with a live subscription row", async () => {
    stripeEnv()
    seedSubscription({ providerSubscriptionId: "sub_test" })
    stripeSessionStub.current = paidStripeSession()
    const result = await verifyCheckoutReturn("user-1", "STRIPE", "cs_test_1")
    expect(result).toEqual({ verified: true, pending: false })
  })

  it("reports pending when the Stripe session is paid but the webhook has not landed", async () => {
    stripeEnv()
    stripeSessionStub.current = paidStripeSession()
    const result = await verifyCheckoutReturn("user-1", "STRIPE", "cs_test_1")
    expect(result.verified).toBe(false)
    expect(result.pending).toBe(true)
  })

  it("refuses verification for an unpaid session or a different user", async () => {
    stripeEnv()
    stripeSessionStub.current = paidStripeSession({ payment_status: "unpaid" })
    expect(
      await verifyCheckoutReturn("user-1", "STRIPE", "cs_test_1")
    ).toMatchObject({ verified: false, pending: false })
    stripeSessionStub.current = paidStripeSession()
    expect(
      await verifyCheckoutReturn("user-2", "STRIPE", "cs_test_1")
    ).toMatchObject({ verified: false, pending: false })
  })

  it("reconciles a paid Stripe checkout whose webhook was lost (BIL-016)", async () => {
    stripeEnv()
    stripeSessionStub.current = paidStripeSession()
    const summary = await reconcileCheckout("user-1", {
      provider: "STRIPE",
      providerCheckoutId: "cs_test_1",
    })
    expect(summary.status).toBe("ACTIVE")
    // The summary carries no provider id — the stored row does.
    expect([...store.subscriptions.values()][0]?.providerSubscriptionId).toBe(
      "sub_test"
    )
    expect(store.subscriptions.size).toBe(1)
    // Idempotent: a late webhook (or a second reconcile) returns the
    // same row instead of a duplicate subscription.
    const again = await reconcileCheckout("user-1", {
      provider: "STRIPE",
      providerCheckoutId: "cs_test_1",
    })
    expect(again.id).toBe(summary.id)
    expect(store.subscriptions.size).toBe(1)
  })

  it("refuses reconciliation for an unpaid Stripe checkout (422) or another user's (403)", async () => {
    stripeEnv()
    stripeSessionStub.current = paidStripeSession({ payment_status: "unpaid" })
    await expect(
      reconcileCheckout("user-1", {
        provider: "STRIPE",
        providerCheckoutId: "cs_test_1",
      })
    ).rejects.toMatchObject({ status: 422 })
    stripeSessionStub.current = paidStripeSession()
    await expect(
      reconcileCheckout("user-2", {
        provider: "STRIPE",
        providerCheckoutId: "cs_test_1",
      })
    ).rejects.toMatchObject({ status: 403 })
    expect(store.subscriptions.size).toBe(0)
  })

  it("verifies and reconciles a PayPal subscription", async () => {
    paypalEnv()
    stubPayPalFetch((url) => {
      if (url.includes("/v1/billing/subscriptions/I-TESTSUB")) {
        return {
          id: "I-TESTSUB",
          status: "ACTIVE",
          custom_id: "user-1:pv-1",
          billing_info: { next_billing_time: "2027-01-01T00:00:00Z" },
        }
      }
      return null
    })
    const verified = await verifyCheckoutReturn("user-1", "PAYPAL", "I-TESTSUB")
    expect(verified).toMatchObject({ verified: false, pending: true })
    const summary = await reconcileCheckout("user-1", {
      provider: "PAYPAL",
      providerCheckoutId: "I-TESTSUB",
    })
    expect(summary.status).toBe("ACTIVE")
    expect([...store.subscriptions.values()][0]?.providerSubscriptionId).toBe(
      "I-TESTSUB"
    )
    expect(summary.currentPeriodEnd?.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z"
    )
    const verifiedAfter = await verifyCheckoutReturn(
      "user-1",
      "PAYPAL",
      "I-TESTSUB"
    )
    expect(verifiedAfter).toEqual({ verified: true, pending: false })
  })

  it("verifies a PayPal one-time order via its capture", async () => {
    paypalEnv()
    stubPayPalFetch((url) => {
      if (url.includes("/v2/checkout/orders/order_1")) {
        return {
          id: "order_1",
          status: "COMPLETED",
          purchase_units: [
            {
              custom_id: "user-1:pv-1",
              payments: {
                captures: [{ id: "cap_1", custom_id: "user-1:pv-1" }],
              },
            },
          ],
        }
      }
      return null
    })
    const summary = await reconcileCheckout("user-1", {
      provider: "PAYPAL",
      providerCheckoutId: "order_1",
    })
    // The summary carries no provider id — the stored row does.
    expect([...store.subscriptions.values()][0]?.providerSubscriptionId).toBe(
      "cap_1"
    )
    expect(summary.status).toBe("ACTIVE")
    const verified = await verifyCheckoutReturn("user-1", "PAYPAL", "order_1")
    expect(verified).toEqual({ verified: true, pending: false })
  })

  it("does not verify Polar/Freemius returns (no provider id to check)", async () => {
    expect(
      await verifyCheckoutReturn("user-1", "POLAR", "co_polar_1")
    ).toMatchObject({
      verified: false,
      pending: false,
      reason: expect.stringContaining("not supported"),
    })
    expect(
      await verifyCheckoutReturn("user-1", "FREEMIUS", "lic_1")
    ).toMatchObject({ verified: false, pending: false })
  })
})

describe("Billing Portal (BIL-017)", () => {
  it("creates a portal session for a user with a stored Stripe customer", async () => {
    stripeEnv()
    store.users.get("user-1")!.stripeCustomerId = "cus_test_1"
    const result = await createBillingPortalSession("user-1")
    expect(result.url).toBe("https://billing.stripe.test/portal")
    expect(mockStripePortalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_test_1" })
    )
  })

  it("422s when the user has never paid through Stripe", async () => {
    stripeEnv()
    await expect(createBillingPortalSession("user-1")).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("No Stripe customer"),
    })
    expect(mockStripePortalCreate).not.toHaveBeenCalled()
  })
})

describe("checkout attempts list (BIL-028)", () => {
  it("filters attempts by provider and status", async () => {
    stripeEnv()
    polarEnv()
    seedVersion()
    seedConfig("STRIPE", true, [])
    seedConfig("POLAR", true, [])
    await createCheckoutSession(customerSession, {
      planVersionId: "pv-1",
      provider: "STRIPE",
    })
    await createCheckoutSession(customerSession, {
      planVersionId: "pv-1",
      provider: "POLAR",
    })
    const stripeOnly = await listCheckoutAttempts(ownerSession, {
      page: 1,
      perPage: 20,
      provider: "STRIPE",
    })
    expect(stripeOnly.total).toBe(1)
    expect(stripeOnly.attempts[0]?.provider).toBe("STRIPE")
    const completed = await listCheckoutAttempts(ownerSession, {
      page: 1,
      perPage: 20,
      status: "COMPLETED",
    })
    expect(completed.total).toBe(2)
    const failed = await listCheckoutAttempts(ownerSession, {
      page: 1,
      perPage: 20,
      status: "FAILED",
    })
    expect(failed.total).toBe(0)
  })
})
