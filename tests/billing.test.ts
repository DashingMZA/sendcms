// Billing providers (Admin Control Plane, Phase 8) with a mocked
// Prisma client and mocked plans webhook functions. The real billing
// service, registry, validators, and Stripe/Freemius webhook
// verification run — only the database, the audit writer, and the
// plans activation functions are stubbed. No test hits the real DB,
// a real provider, or the network (except PayPal's verification,
// whose fetch is stubbed). Stripe signatures are computed for real
// with HMAC-SHA256, so the verification path is genuinely exercised.
import { createHmac } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AdminSession } from "@sendcms/auth"
import { FREE_PLAN_V1_ENTITLEMENTS } from "@sendcms/plans/validators"

function makeSession(
  overrides: Partial<AdminSession["user"]> = {}
): AdminSession {
  return {
    user: {
      id: "admin-1",
      name: "Admin",
      email: "admin@csofts.com",
      image: null,
      platformRole: "PLATFORM_OWNER",
      status: "ACTIVE",
      adminRole: null,
      emailVerified: true,
      ...overrides,
    },
    session: { id: "sess-1", userId: "admin-1", expiresAt: new Date() },
  }
}

const ownerSession = makeSession()
const supportSession = makeSession({
  id: "support-1",
  email: "support@example.com",
  platformRole: "PLATFORM_USER",
  adminRole: "SUPPORT",
})

const mockLogAudit = vi.hoisted(() => vi.fn(async () => undefined))
const mockActivate = vi.hoisted(() => vi.fn(async () => null))
const mockCancel = vi.hoisted(() => vi.fn(async () => null))
const mockExtend = vi.hoisted(() => vi.fn(async () => null))
const mockMarkPastDue = vi.hoisted(() => vi.fn(async () => null))

// A stateful in-memory fake DB. Prisma `select`/`include` args are
// ignored — the code only reads the fields it needs.
const { store, mockDb } = vi.hoisted(() => {
  type StoredConfig = {
    id: string
    provider: string
    isEnabled: boolean
    countries: string[]
  }
  type StoredEvent = {
    id: string
    provider: string
    providerEventId: string
    eventType: string
    processedAt: Date | null
    createdAt: Date
  }
  type StoredVersion = {
    id: string
    planId: string
    status: string
    priceAmount: number | null
    priceCurrency: string
    billingInterval: string
    trialDays: number
  }
  type StoredPlan = {
    id: string
    name: string
    slug: string
    description: string | null
    kind: string
    status: string
    isPrivate: boolean
    currentVersion:
      | (StoredVersion & {
          version: number
          entitlements: Record<string, unknown>
        })
      | null
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
    versions: new Map<string, StoredVersion>(),
    plans: [] as StoredPlan[],
    users: new Map<string, { id: string; email: string }>(),
    eventSeq: 1,
  }

  function toConfigRow(row: StoredConfig) {
    return {
      ...row,
      countries: row.countries.map((code) => ({ countryCode: code })),
    }
  }

  const billingProviderConfig = {
    findMany: vi.fn(async ({ where }: { where?: { isEnabled?: boolean } }) =>
      [...store.configs.values()]
        .filter(
          (c) =>
            where?.isEnabled === undefined || c.isEnabled === where.isEnabled
        )
        .map(toConfigRow)
    ),
    findUnique: vi.fn(async ({ where }: { where: { provider: string } }) => {
      const row = store.configs.get(where.provider)
      return row ? toConfigRow(row) : null
    }),
    findUniqueOrThrow: vi.fn(
      async ({ where }: { where: { provider: string } }) => {
        const row = store.configs.get(where.provider)
        if (!row) throw new Error("not found")
        return toConfigRow(row)
      }
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { provider: string }
        create: { provider: string; isEnabled?: boolean }
        update: { isEnabled?: boolean }
      }) => {
        const existing = store.configs.get(where.provider)
        if (existing) {
          if (update.isEnabled !== undefined) {
            existing.isEnabled = update.isEnabled
          }
          return toConfigRow(existing)
        }
        const row: StoredConfig = {
          id: `cfg-${where.provider}`,
          provider: where.provider,
          isEnabled: create.isEnabled ?? false,
          countries: [],
        }
        store.configs.set(where.provider, row)
        return toConfigRow(row)
      }
    ),
  }

  const mockDb = {
    billingProviderConfig,
    billingProviderCountry: {
      deleteMany: vi.fn(
        async ({ where }: { where: { providerConfigId: string } }) => {
          const row = [...store.configs.values()].find(
            (c) => c.id === where.providerConfigId
          )
          if (row) row.countries = []
          return { count: 0 }
        }
      ),
      createMany: vi.fn(
        async ({
          data,
        }: {
          data: { providerConfigId: string; countryCode: string }[]
        }) => {
          for (const item of data) {
            const row = [...store.configs.values()].find(
              (c) => c.id === item.providerConfigId
            )
            if (row && !row.countries.includes(item.countryCode)) {
              row.countries.push(item.countryCode)
            }
          }
          return { count: data.length }
        }
      ),
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
      create: vi.fn(
        async ({
          data,
        }: {
          data: { provider: string; providerEventId: string; eventType: string }
        }) => {
          const row: StoredEvent = {
            id: `evt-${store.eventSeq++}`,
            processedAt: null,
            createdAt: new Date(),
            ...data,
          }
          store.events.set(`${data.provider}:${data.providerEventId}`, row)
          return row
        }
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string }
          data: { processedAt?: Date }
        }) => {
          const row = [...store.events.values()].find((e) => e.id === where.id)
          if (!row) throw new Error("not found")
          if (data.processedAt !== undefined) row.processedAt = data.processedAt
          return row
        }
      ),
    },
    planVersion: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = store.versions.get(where.id)
        if (!row) return null
        return { ...row, plan: { name: "Pro" } }
      }),
    },
    plan: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where?: { status?: string; isPrivate?: boolean }
        }) =>
          store.plans.filter(
            (p) =>
              (where?.status === undefined || p.status === where.status) &&
              (where?.isPrivate === undefined ||
                p.isPrivate === where.isPrivate)
          )
      ),
    },
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { email?: string; id?: string } }) => {
          if (where.email) {
            return (
              [...store.users.values()].find((u) => u.email === where.email) ??
              null
            )
          }
          return store.users.get(where.id ?? "") ?? null
        }
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(mockDb)
    ),
    // DB-051: the locked read in setProviderConfig. The template tag
    // arrives as (strings, ...values); values[0] is the provider.
    $queryRaw: vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?")
        if (sql.includes('"BillingProviderConfig"')) {
          const row = store.configs.get(values[0] as string)
          return row ? [{ id: row.id }] : []
        }
        return []
      }
    ),
  }

  return { store, mockDb }
})

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", () => ({ logAudit: mockLogAudit }))
vi.mock("@sendcms/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/plans")>()
  return {
    ...actual,
    activateSubscriptionFromCheckout: mockActivate,
    cancelSubscriptionFromProvider: mockCancel,
    extendSubscriptionPeriod: mockExtend,
    markSubscriptionPastDue: mockMarkPastDue,
  }
})

import {
  createCheckoutSession,
  handleWebhook,
  listEnabledProviders,
  listProviderConfigs,
  setProviderConfig,
} from "@sendcms/billing"
import { listPublishedPlans } from "@sendcms/plans"
import { setProviderConfigSchema } from "@sendcms/billing/validators"
import {
  isProviderConfigured,
  missingEnvVars,
  stripeKeyModeMismatch,
} from "@sendcms/billing"

const savedEnv: Record<string, string | undefined> = {}

function setEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
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

function seedVersion(overrides: Record<string, unknown> = {}) {
  const version = {
    id: "pv-1",
    planId: "plan-1",
    status: "PUBLISHED",
    priceAmount: 9900,
    priceCurrency: "USD",
    billingInterval: "MONTHLY",
    trialDays: 0,
    ...overrides,
  }
  store.versions.set(version.id as string, version)
  return version
}

beforeEach(() => {
  store.configs.clear()
  store.events.clear()
  store.versions.clear()
  store.plans.length = 0
  store.users.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key]
})

describe("provider registry — configured/unconfigured", () => {
  it("reports every provider unconfigured with its missing vars", () => {
    setEnv({
      STRIPE_SECRET_KEY: undefined,
      STRIPE_PUBLISHABLE_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
      PAYPAL_CLIENT_ID: undefined,
      PAYPAL_CLIENT_SECRET: undefined,
      PAYPAL_WEBHOOK_ID: undefined,
      POLAR_ACCESS_TOKEN: undefined,
      POLAR_WEBHOOK_SECRET: undefined,
      FREEMIUS_PRODUCT_ID: undefined,
      FREEMIUS_API_KEY: undefined,
      FREEMIUS_SECRET_KEY: undefined,
      FREEMIUS_PUBLIC_KEY: undefined,
      GUMROAD_APP_ID: undefined,
      GUMROAD_APP_SECRET: undefined,
    })
    expect(isProviderConfigured("STRIPE")).toBe(false)
    expect(missingEnvVars("STRIPE")).toEqual([
      "STRIPE_SECRET_KEY",
      "STRIPE_PUBLISHABLE_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ])
    expect(isProviderConfigured("GUMROAD")).toBe(false)
    expect(missingEnvVars("GUMROAD")).toEqual([
      "GUMROAD_APP_ID",
      "GUMROAD_APP_SECRET",
    ])
  })

  it("reports a provider configured once all its vars are set", () => {
    setEnv({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_PUBLISHABLE_KEY: "pk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
    })
    expect(isProviderConfigured("STRIPE")).toBe(true)
    expect(missingEnvVars("STRIPE")).toEqual([])
    expect(isProviderConfigured("PAYPAL")).toBe(false)
  })
})

describe("admin provider configs", () => {
  // BIL-129 (Phase 16, Wave 3): the GET is a pure read — the five
  // rows are seeded by migration
  // 20261124154500_seed_billing_provider_configs, never created by
  // the read path. These tests assert on seeded rows.
  it("returns all five seeded rows, in provider order", async () => {
    for (const provider of [
      "STRIPE",
      "PAYPAL",
      "POLAR",
      "FREEMIUS",
      "GUMROAD",
    ]) {
      seedConfig(provider, false, [])
    }
    const rows = await listProviderConfigs(ownerSession)
    expect(rows.map((r) => r.provider)).toEqual([
      "STRIPE",
      "PAYPAL",
      "POLAR",
      "FREEMIUS",
      "GUMROAD",
    ])
    expect(rows.every((r) => r.isEnabled === false)).toBe(true)
    expect(rows.every((r) => r.allCountries)).toBe(true)
    expect(
      rows.find((r) => r.provider === "GUMROAD")?.checkoutImplemented
    ).toBe(false)
    expect(rows.find((r) => r.provider === "STRIPE")?.checkoutImplemented).toBe(
      true
    )
    expect(mockDb.billingProviderConfig.upsert).not.toHaveBeenCalled()
  })

  it("returns five rows with zero config rows — and writes nothing", async () => {
    const rows = await listProviderConfigs(ownerSession)
    expect(rows.map((r) => r.provider)).toEqual([
      "STRIPE",
      "PAYPAL",
      "POLAR",
      "FREEMIUS",
      "GUMROAD",
    ])
    expect(rows.every((r) => r.isEnabled === false)).toBe(true)
    expect(rows.every((r) => r.countries.length === 0)).toBe(true)
    expect(store.configs.size).toBe(0)
    expect(mockDb.billingProviderConfig.upsert).not.toHaveBeenCalled()
  })

  // ADM-125: a missing required `reason` fails with the human,
  // field-named message — not Zod's raw "Invalid input: expected
  // string, received undefined".
  it("names a missing reason instead of raw Zod phrasing", () => {
    const parsed = setProviderConfigSchema.safeParse({ isEnabled: true })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe("A reason is required")
      expect(JSON.stringify(parsed.error.issues)).not.toContain(
        "expected string, received undefined"
      )
    }
  })

  // BIL-125 (Phase 16, Wave 3): the owner-approved country defaults
  // seeded by migration 20261124154600_seed_billing_provider_countries
  // (PayPal US/GB/AU/DE, Gumroad PK, Stripe/Polar/Freemius all
  // countries) — listed as seeded, and PayPal never offered in PK.
  it("returns the seeded country defaults; PK excludes PayPal", async () => {
    setEnv({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_PUBLISHABLE_KEY: "pk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: "secret",
      PAYPAL_WEBHOOK_ID: "wh",
      GUMROAD_APP_ID: "gum-id",
      GUMROAD_APP_SECRET: "gum-secret",
    })
    seedConfig("STRIPE", true, [])
    seedConfig("PAYPAL", true, ["US", "GB", "AU", "DE"])
    seedConfig("GUMROAD", true, ["PK"])
    const rows = await listProviderConfigs(ownerSession)
    expect(rows.find((r) => r.provider === "PAYPAL")?.countries).toEqual([
      "US",
      "GB",
      "AU",
      "DE",
    ])
    expect(rows.find((r) => r.provider === "GUMROAD")?.countries).toEqual([
      "PK",
    ])
    expect(rows.find((r) => r.provider === "STRIPE")?.allCountries).toBe(true)
    const pkProviders = (await listEnabledProviders("PK")).map(
      (p) => p.provider
    )
    expect(pkProviders).toContain("STRIPE")
    expect(pkProviders).not.toContain("PAYPAL")
    expect((await listEnabledProviders("AU")).map((p) => p.provider)).toContain(
      "PAYPAL"
    )
  })

  it("refuses to enable an unconfigured provider, naming the missing vars", async () => {
    setEnv({
      STRIPE_SECRET_KEY: undefined,
      STRIPE_PUBLISHABLE_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
    })
    await expect(
      setProviderConfig(ownerSession, "STRIPE", {
        isEnabled: true,
        reason: "turn it on",
      })
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("STRIPE_SECRET_KEY"),
    })
  })

  it("refuses unknown country codes", async () => {
    await expect(
      setProviderConfig(ownerSession, "STRIPE", {
        countries: ["XX"],
        reason: "test",
      })
    ).rejects.toMatchObject({ status: 422 })
  })

  it("forbids support staff from managing billing", async () => {
    await expect(
      setProviderConfig(supportSession, "STRIPE", {
        isEnabled: false,
        reason: "test",
      })
    ).rejects.toMatchObject({ status: 403 })
  })

  it("enables a configured provider and stores its countries", async () => {
    setEnv({
      PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: "secret",
      PAYPAL_WEBHOOK_ID: "wh",
    })
    const row = await setProviderConfig(ownerSession, "PAYPAL", {
      isEnabled: true,
      countries: ["US", "GB"],
      reason: "launch",
    })
    expect(row.isEnabled).toBe(true)
    expect(row.countries).toEqual(["US", "GB"])
    expect(row.allCountries).toBe(false)
    expect(mockLogAudit).toHaveBeenCalled()
  })
})

describe("listEnabledProviders — country filter", () => {
  beforeEach(() => {
    setEnv({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_PUBLISHABLE_KEY: "pk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: "secret",
      PAYPAL_WEBHOOK_ID: "wh",
      // Gumroad deliberately unconfigured.
      GUMROAD_APP_ID: undefined,
      GUMROAD_APP_SECRET: undefined,
    })
    seedConfig("STRIPE", true, []) // everywhere
    // BIL-125: the fixture matches the seeded owner defaults
    // (PayPal US/GB/AU/DE), not the old three-country subset.
    seedConfig("PAYPAL", true, ["US", "GB", "AU", "DE"])
    seedConfig("GUMROAD", true, ["PK"])
    seedConfig("POLAR", false, [])
  })

  it("US gets Stripe + PayPal, PK gets Stripe only (Gumroad unconfigured)", async () => {
    expect((await listEnabledProviders("US")).map((p) => p.provider)).toEqual([
      "STRIPE",
      "PAYPAL",
    ])
    expect((await listEnabledProviders("PK")).map((p) => p.provider)).toEqual([
      "STRIPE",
    ])
    expect((await listEnabledProviders("AE")).map((p) => p.provider)).toEqual([
      "STRIPE",
    ])
  })

  it("hides disabled providers and shows all when no country is given", async () => {
    expect((await listEnabledProviders(null)).map((p) => p.provider)).toEqual([
      "STRIPE",
      "PAYPAL",
    ])
  })
})

describe("checkout refuses unavailable providers", () => {
  beforeEach(() => {
    seedVersion()
  })

  it("refuses a disabled provider", async () => {
    seedConfig("STRIPE", false, [])
    await expect(
      createCheckoutSession(ownerSession, {
        planVersionId: "pv-1",
        provider: "STRIPE",
      })
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("not enabled"),
    })
  })

  it("refuses an enabled but unconfigured provider, naming the vars", async () => {
    seedConfig("STRIPE", true, [])
    setEnv({
      STRIPE_SECRET_KEY: undefined,
      STRIPE_PUBLISHABLE_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
    })
    await expect(
      createCheckoutSession(ownerSession, {
        planVersionId: "pv-1",
        provider: "STRIPE",
      })
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("STRIPE_SECRET_KEY"),
    })
  })

  it("refuses Gumroad checkout (no payment API)", async () => {
    seedConfig("GUMROAD", true, [])
    setEnv({ GUMROAD_APP_ID: "app", GUMROAD_APP_SECRET: "secret" })
    await expect(
      createCheckoutSession(ownerSession, {
        planVersionId: "pv-1",
        provider: "GUMROAD",
      })
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("not available for Gumroad"),
    })
  })

  it("refuses a free plan (no payment needed)", async () => {
    seedVersion({ priceAmount: null })
    seedConfig("STRIPE", true, [])
    setEnv({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_PUBLISHABLE_KEY: "pk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
    })
    await expect(
      createCheckoutSession(ownerSession, {
        planVersionId: "pv-1",
        provider: "STRIPE",
      })
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("free"),
    })
  })

  it("refuses a provider not available in the customer's country", async () => {
    seedConfig("PAYPAL", true, ["US"])
    setEnv({
      PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: "secret",
      PAYPAL_WEBHOOK_ID: "wh",
    })
    await expect(
      createCheckoutSession(ownerSession, {
        planVersionId: "pv-1",
        provider: "PAYPAL",
        countryCode: "PK",
      })
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("not available in your country"),
    })
  })
})

describe("Stripe webhook — signature + idempotency", () => {
  const webhookSecret = "whsec_test_secret"

  function stripeSignature(payload: string): string {
    const ts = Math.floor(Date.now() / 1000)
    const signed = `${ts}.${payload}`
    const v1 = createHmac("sha256", webhookSecret).update(signed).digest("hex")
    return `t=${ts},v1=${v1}`
  }

  beforeEach(() => {
    setEnv({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_PUBLISHABLE_KEY: "pk_test_x",
      STRIPE_WEBHOOK_SECRET: webhookSecret,
    })
  })

  it("verifies a real signature and activates the subscription", async () => {
    const payload = JSON.stringify({
      id: "evt_test_123",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test",
          subscription: "sub_test",
          metadata: { userId: "user-1", planVersionId: "pv-1" },
        },
      },
    })
    const result = await handleWebhook("STRIPE", payload, {
      "stripe-signature": stripeSignature(payload),
    })
    expect(result).toMatchObject({ received: true, kind: "checkout-completed" })
    expect(mockActivate).toHaveBeenCalledTimes(1)
    expect(mockActivate).toHaveBeenCalledWith({
      userId: "user-1",
      planVersionId: "pv-1",
      provider: "STRIPE",
      providerSubscriptionId: "sub_test",
      periodEnd: null,
    })
  })

  it("skips a duplicate event id (idempotency)", async () => {
    const payload = JSON.stringify({
      id: "evt_test_456",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test",
          subscription: "sub_test",
          metadata: { userId: "user-1", planVersionId: "pv-1" },
        },
      },
    })
    const headers = { "stripe-signature": stripeSignature(payload) }
    await handleWebhook("STRIPE", payload, headers)
    const second = await handleWebhook("STRIPE", payload, headers)
    expect(second).toMatchObject({ received: true, duplicate: true })
    expect(mockActivate).toHaveBeenCalledTimes(1)
  })

  it("rejects a bad signature with 401", async () => {
    const payload = JSON.stringify({
      id: "evt_test_789",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test" } },
    })
    await expect(
      handleWebhook("STRIPE", payload, {
        "stripe-signature": "t=123,v1=deadbeef",
      })
    ).rejects.toMatchObject({ status: 401 })
    expect(mockActivate).not.toHaveBeenCalled()
  })
})

describe("PayPal webhook — verification + activation", () => {
  beforeEach(() => {
    setEnv({
      PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: "secret",
      PAYPAL_WEBHOOK_ID: "wh_123",
    })
  })

  it("verifies via PayPal and activates from custom_id", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/oauth2/token")) {
        return {
          ok: true,
          json: async () => ({ access_token: "tok" }),
        }
      }
      return {
        ok: true,
        json: async () => ({ verification_status: "SUCCESS" }),
      }
    })
    vi.stubGlobal("fetch", fetchMock)
    try {
      const payload = JSON.stringify({
        id: "WH-test-1",
        event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
        resource: { id: "I-TESTSUB", custom_id: "user-1:pv-1" },
      })
      const result = await handleWebhook("PAYPAL", payload, {
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://example.com/cert",
        "paypal-transmission-id": "tx-1",
        "paypal-transmission-sig": "sig",
        "paypal-transmission-time": new Date().toISOString(),
      })
      expect(result).toMatchObject({
        received: true,
        kind: "checkout-completed",
      })
      expect(mockActivate).toHaveBeenCalledWith({
        userId: "user-1",
        planVersionId: "pv-1",
        provider: "PAYPAL",
        providerSubscriptionId: "I-TESTSUB",
        periodEnd: null,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("Freemius webhook — HMAC + plan mapping", () => {
  it("verifies HMAC and activates from the plan map + buyer email", async () => {
    const secret = "freemius-secret"
    setEnv({
      FREEMIUS_SECRET_KEY: secret,
      FREEMIUS_PLAN_MAP: JSON.stringify({ "pv-1": "123" }),
    })
    store.users.set("buyer-1", { id: "buyer-1", email: "buyer@example.com" })
    const payload = JSON.stringify({
      id: "fs-evt-1",
      type: "license.created",
      objects: {
        license: { plan_id: 123 },
        user: { email: "buyer@example.com" },
      },
      data: { license_id: "lic_1" },
    })
    const signature = createHmac("sha256", secret).update(payload).digest("hex")
    const result = await handleWebhook("FREEMIUS", payload, {
      "x-signature": signature,
    })
    expect(result).toMatchObject({
      received: true,
      kind: "checkout-completed",
    })
    expect(mockActivate).toHaveBeenCalledWith({
      userId: "buyer-1",
      planVersionId: "pv-1",
      provider: "FREEMIUS",
      providerSubscriptionId: "lic_1",
      periodEnd: null,
    })
  })

  it("rejects a bad HMAC with 401", async () => {
    setEnv({ FREEMIUS_SECRET_KEY: "freemius-secret" })
    await expect(
      handleWebhook("FREEMIUS", "{}", { "x-signature": "deadbeef" })
    ).rejects.toMatchObject({ status: 401 })
  })
})

describe("public plans — only published, non-private plans", () => {
  it("returns the published plan with its current version, nothing else", async () => {
    const entitlements = { ...FREE_PLAN_V1_ENTITLEMENTS }
    store.plans.push(
      {
        id: "plan-1",
        name: "Pro",
        slug: "pro",
        description: "Pro plan",
        kind: "PAID",
        status: "PUBLISHED",
        isPrivate: false,
        currentVersion: {
          id: "pv-1",
          planId: "plan-1",
          version: 1,
          status: "PUBLISHED",
          priceAmount: 9900,
          priceCurrency: "USD",
          billingInterval: "MONTHLY",
          trialDays: 7,
          entitlements,
        },
      },
      {
        id: "plan-2",
        name: "Draft plan",
        slug: "draft",
        description: null,
        kind: "PAID",
        status: "DRAFT",
        isPrivate: false,
        currentVersion: null,
      },
      {
        id: "plan-3",
        name: "Private plan",
        slug: "private",
        description: null,
        kind: "PAID",
        status: "PUBLISHED",
        isPrivate: true,
        currentVersion: {
          id: "pv-3",
          planId: "plan-3",
          version: 1,
          status: "PUBLISHED",
          priceAmount: 100,
          priceCurrency: "USD",
          billingInterval: "MONTHLY",
          trialDays: 0,
          entitlements,
        },
      }
    )
    const plans = await listPublishedPlans()
    expect(plans.map((p) => p.slug)).toEqual(["pro"])
    expect(plans[0].version.priceAmount).toBe(9900)
    expect(plans[0].version.entitlements).toEqual(entitlements)
  })
})

describe("Polar webhook — async verification + webhook-id event id (BIL-040 / BIL-041)", () => {
  const secret = "whsec_polar_test_secret"

  // Standard Webhooks signing: v1,base64(HMAC-SHA256(secret,
  // "<webhook-id>.<timestamp>.<body>")) — verified against the real
  // installed SDK before these tests were written.
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

  function checkoutPayload() {
    return JSON.stringify({
      type: "checkout.updated",
      timestamp: new Date().toISOString(),
      api_version: "2026-10",
      data: {
        status: "confirmed",
        subscription_id: "sub_polar_1",
        metadata: { user_id: "user-1", plan_version_id: "pv-1" },
      },
    })
  }

  beforeEach(() => {
    setEnv({ POLAR_WEBHOOK_SECRET: secret })
  })

  it("verifies a signed checkout.updated and activates the subscription", async () => {
    const payload = checkoutPayload()
    const result = await handleWebhook(
      "POLAR",
      payload,
      polarHeaders("msg_polar_1", payload)
    )
    expect(result).toMatchObject({
      received: true,
      kind: "checkout-completed",
    })
    expect(mockActivate).toHaveBeenCalledTimes(1)
    expect(mockActivate).toHaveBeenCalledWith({
      userId: "user-1",
      planVersionId: "pv-1",
      provider: "POLAR",
      providerSubscriptionId: "sub_polar_1",
      periodEnd: null,
    })
  })

  it("dedupes a redelivery with the same webhook-id (BIL-041)", async () => {
    const payload = checkoutPayload()
    const headers = polarHeaders("msg_polar_2", payload)
    await handleWebhook("POLAR", payload, headers)
    const second = await handleWebhook("POLAR", payload, headers)
    expect(second).toMatchObject({ received: true, duplicate: true })
    expect(mockActivate).toHaveBeenCalledTimes(1)
  })

  it("rejects a bad signature with 401 and no unhandled rejection", async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => {
      rejections.push(reason)
    }
    process.on("unhandledRejection", onRejection)
    try {
      const payload = checkoutPayload()
      const headers = polarHeaders("msg_polar_3", payload)
      await expect(
        handleWebhook("POLAR", payload, {
          ...headers,
          "webhook-signature": "v1,badbadbadbad",
        })
      ).rejects.toMatchObject({ status: 401 })
      expect(mockActivate).not.toHaveBeenCalled()
      // Let any floating rejection surface before asserting.
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(rejections).toEqual([])
    } finally {
      process.off("unhandledRejection", onRejection)
    }
  })

  it("maps a past-due subscription update to PAST_DUE (BIL-080)", async () => {
    const payload = JSON.stringify({
      type: "subscription.updated",
      timestamp: new Date().toISOString(),
      api_version: "2026-10",
      data: { id: "sub_polar_1", status: "past_due" },
    })
    const result = await handleWebhook(
      "POLAR",
      payload,
      polarHeaders("msg_polar_4", payload)
    )
    expect(result).toMatchObject({ received: true, kind: "payment-failed" })
    expect(mockMarkPastDue).toHaveBeenCalledWith("POLAR", "sub_polar_1")
  })
})

describe("Stripe test/live key separation (BIL-010)", () => {
  it("accepts a test key outside production", () => {
    setEnv({ NODE_ENV: "test", STRIPE_SECRET_KEY: "sk_test_x" })
    expect(stripeKeyModeMismatch()).toBeNull()
  })

  it("accepts a live key in production", () => {
    setEnv({ NODE_ENV: "production", STRIPE_SECRET_KEY: "sk_live_x" })
    expect(stripeKeyModeMismatch()).toBeNull()
  })

  it("flags a test key in production", () => {
    setEnv({ NODE_ENV: "production", STRIPE_SECRET_KEY: "sk_test_x" })
    expect(stripeKeyModeMismatch()).toMatchObject({
      expected: "live",
      actual: "test",
    })
  })

  it("flags a live key when STRIPE_MODE=test overrides the environment", () => {
    setEnv({
      NODE_ENV: "production",
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: "sk_live_x",
    })
    expect(stripeKeyModeMismatch()).toMatchObject({
      expected: "test",
      actual: "live",
    })
  })

  it("refuses checkout with a test key in production", async () => {
    seedVersion()
    seedConfig("STRIPE", true, [])
    setEnv({
      NODE_ENV: "production",
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_PUBLISHABLE_KEY: "pk_test_x",
      STRIPE_WEBHOOK_SECRET: "test-hook-value",
    })
    await expect(
      createCheckoutSession(ownerSession, {
        planVersionId: "pv-1",
        provider: "STRIPE",
      })
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("does not match"),
    })
  })
})

describe("PayPal webhook — generic 502 (BIL-024)", () => {
  beforeEach(() => {
    setEnv({
      PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: "client-value",
      PAYPAL_WEBHOOK_ID: "wh_123",
    })
  })

  it("does not surface provider error detail to the caller", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/oauth2/token")) {
        return { ok: true, json: async () => ({ access_token: "tok" }) }
      }
      return {
        ok: false,
        status: 400,
        json: async () => ({ message: "ACCOUNT_FROZEN internal detail" }),
      }
    })
    vi.stubGlobal("fetch", fetchMock)
    try {
      const payload = JSON.stringify({
        id: "WH-test-err",
        event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
        resource: { id: "I-TESTSUB", custom_id: "user-1:pv-1" },
      })
      let thrown: unknown = null
      try {
        await handleWebhook("PAYPAL", payload, {
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://example.com/cert",
          "paypal-transmission-id": "tx-1",
          "paypal-transmission-sig": "sig",
          "paypal-transmission-time": new Date().toISOString(),
        })
      } catch (err) {
        thrown = err
      }
      expect(thrown).toMatchObject({
        status: 502,
        message: "The payment provider is unavailable. Please try again.",
      })
      expect((thrown as Error).message).not.toContain("ACCOUNT_FROZEN")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("maps a failed subscription payment to PAST_DUE (BIL-080)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/oauth2/token")) {
        return { ok: true, json: async () => ({ access_token: "tok" }) }
      }
      return {
        ok: true,
        json: async () => ({ verification_status: "SUCCESS" }),
      }
    })
    vi.stubGlobal("fetch", fetchMock)
    try {
      const payload = JSON.stringify({
        id: "WH-test-pf",
        event_type: "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
        resource: { id: "I-TESTSUB" },
      })
      const result = await handleWebhook("PAYPAL", payload, {
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://example.com/cert",
        "paypal-transmission-id": "tx-1",
        "paypal-transmission-sig": "sig",
        "paypal-transmission-time": new Date().toISOString(),
      })
      expect(result).toMatchObject({
        received: true,
        kind: "payment-failed",
      })
      expect(mockMarkPastDue).toHaveBeenCalledWith("PAYPAL", "I-TESTSUB")
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("Stripe webhook — failed invoice maps to PAST_DUE (BIL-080)", () => {
  const webhookSecret = "whsec_test_secret"

  function stripeSignature(payload: string): string {
    const ts = Math.floor(Date.now() / 1000)
    const signed = `${ts}.${payload}`
    const v1 = createHmac("sha256", webhookSecret).update(signed).digest("hex")
    return `t=${ts},v1=${v1}`
  }

  beforeEach(() => {
    setEnv({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_PUBLISHABLE_KEY: "pk_test_x",
      STRIPE_WEBHOOK_SECRET: webhookSecret,
    })
  })

  it("invoice.payment_failed calls markSubscriptionPastDue", async () => {
    const payload = JSON.stringify({
      id: "evt_test_pf",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_test",
          parent: {
            subscription_details: { subscription: "sub_test" },
          },
        },
      },
    })
    const result = await handleWebhook("STRIPE", payload, {
      "stripe-signature": stripeSignature(payload),
    })
    expect(result).toMatchObject({ received: true, kind: "payment-failed" })
    expect(mockMarkPastDue).toHaveBeenCalledWith("STRIPE", "sub_test")
  })
})

describe("Freemius webhook — replay protection (BIL-088)", () => {
  function deliver(payload: string, signature: string) {
    return handleWebhook("FREEMIUS", payload, { "x-signature": signature })
  }

  it("dedupes a replay inside the window, rejects it after the window", async () => {
    const secret = "freemius-secret"
    setEnv({
      FREEMIUS_SECRET_KEY: secret,
      FREEMIUS_PLAN_MAP: JSON.stringify({ "pv-1": "123" }),
    })
    store.users.set("buyer-1", { id: "buyer-1", email: "buyer@example.com" })
    const payload = JSON.stringify({
      id: "fs-evt-replay",
      type: "license.created",
      objects: {
        license: { plan_id: 123 },
        user: { email: "buyer@example.com" },
      },
      data: { license_id: "lic_1" },
    })
    const signature = createHmac("sha256", secret).update(payload).digest("hex")

    const first = await deliver(payload, signature)
    expect(first).toMatchObject({ received: true, kind: "checkout-completed" })
    const second = await deliver(payload, signature)
    expect(second).toMatchObject({ received: true, duplicate: true })
    expect(mockActivate).toHaveBeenCalledTimes(1)

    // Age the first-seen record past the 10-minute window: the same
    // captured payload is now a replay, not a redelivery.
    const stored = [...store.events.values()].find(
      (event) => event.providerEventId === "fs-evt-replay"
    )
    expect(stored).toBeDefined()
    stored!.createdAt = new Date(Date.now() - 11 * 60 * 1000)
    await expect(deliver(payload, signature)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Replayed"),
    })
    expect(mockActivate).toHaveBeenCalledTimes(1)
  })
})
