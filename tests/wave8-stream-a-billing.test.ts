// Phase 16, Wave 8 — Stream A (Billing P1 core).
//
// Billing webhook handler tests: the P2002-only duplicate catch
// (SRC-205), Freemius replay + buyer resolution (BIL-088 / SRC-207),
// Stripe refund/update/one-time mapping (BIL-003/004/005/081),
// unmapped payments left unprocessed (BIL-100), and country
// enforcement on checkout (BIL-121). Real Stripe/Freemius/Polar
// webhook verification runs (HMAC/Svix signatures computed for
// real); only the database, the audit writer, and the plans
// functions are stubbed. No test hits the real DB, a real provider,
// or the network.
import { createHmac } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@sendcms/database"
import type { AdminSession } from "@sendcms/auth"

const mockLogAudit = vi.hoisted(() => vi.fn(async () => undefined))
const mockActivate = vi.hoisted(() => vi.fn(async () => null))
const mockCancel = vi.hoisted(() => vi.fn(async () => null))
const mockExtend = vi.hoisted(() => vi.fn(async () => null))
const mockMarkPastDue = vi.hoisted(() => vi.fn(async () => null))
const mockApplyRefund = vi.hoisted(() => vi.fn(async () => null))
const mockSync = vi.hoisted(() => vi.fn(async () => null))
const mockCreateCheckout = vi.hoisted(() =>
  vi.fn(async () => ({ checkoutUrl: "https://checkout.example.test/pay" }))
)

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
    userId: string | null
    processedAt: Date | null
    createdAt: Date
  }
  const store = {
    configs: new Map<string, StoredConfig>(),
    events: new Map<string, StoredEvent>(),
    versions: new Map<string, Record<string, unknown>>(),
    users: new Map<string, { id: string; email: string }>(),
    eventSeq: 1,
  }
  function toConfigRow(row: StoredConfig) {
    return {
      ...row,
      countries: row.countries.map((code) => ({ countryCode: code })),
    }
  }
  const mockDb = {
    billingProviderConfig: {
      findMany: vi.fn(async () => [...store.configs.values()].map(toConfigRow)),
      findUnique: vi.fn(async ({ where }: { where: { provider: string } }) => {
        const row = store.configs.get(where.provider)
        return row ? toConfigRow(row) : null
      }),
    },
    country: { findMany: vi.fn(async () => []) },
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
          data: {
            provider: string
            providerEventId: string
            eventType: string
            userId?: string | null
          }
        }) => {
          const row: StoredEvent = {
            id: `evt-${store.eventSeq++}`,
            processedAt: null,
            createdAt: new Date(),
            userId: data.userId ?? null,
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
          data: { processedAt?: Date; userId?: string }
        }) => {
          const row = [...store.events.values()].find((e) => e.id === where.id)
          if (!row) throw new Error("not found")
          if (data.processedAt !== undefined) row.processedAt = data.processedAt
          if (data.userId !== undefined) row.userId = data.userId
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
      findFirst: vi.fn(
        async ({ where }: { where: { email?: string; id?: string } }) => {
          if (where.email) {
            return (
              [...store.users.values()].find(
                (u) => u.email.toLowerCase() === where.email?.toLowerCase()
              ) ?? null
            )
          }
          return store.users.get(where.id ?? "") ?? null
        }
      ),
    },
    subscription: { findFirst: vi.fn(async () => null) },
    oneTimePurchase: { findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(mockDb)
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
    applyRefund: mockApplyRefund,
    cancelSubscriptionFromProvider: mockCancel,
    extendSubscriptionPeriod: mockExtend,
    markSubscriptionPastDue: mockMarkPastDue,
    syncSubscriptionFromProvider: mockSync,
  }
})
// BIL-121 positive path only: the checkout creation itself is stubbed
// so the country-gating tests never touch the network. Verification
// (the part under test here) still runs for real.
vi.mock("../packages/modules/billing/src/providers", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../packages/modules/billing/src/providers")
    >()
  return { ...actual, createCheckoutForProvider: mockCreateCheckout }
})

import { createCheckoutSession, handleWebhook } from "@sendcms/billing"

function makeSession(): AdminSession {
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
    },
    session: { id: "sess-1", userId: "user-1", expiresAt: new Date() },
  }
}

const savedEnv: Record<string, string | undefined> = {}
function setEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint", {
    code: "P2002",
    clientVersion: "1.0.0",
  })
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

function seedEvent(overrides: Record<string, unknown> = {}) {
  const seq = store.eventSeq++
  const row = {
    id: `evt-${seq}`,
    provider: "STRIPE",
    providerEventId: `evt_${seq}`,
    eventType: "checkout.session.completed",
    userId: null,
    processedAt: new Date("2026-11-25T10:00:00Z"),
    createdAt: new Date("2026-11-25T10:00:00Z"),
    ...overrides,
  }
  store.events.set(`${row.provider}:${row.providerEventId}`, row)
  return row
}

beforeEach(() => {
  store.configs.clear()
  store.events.clear()
  store.versions.clear()
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

// ─── Stripe helpers ──────────────────────────────────────────────────

const STRIPE_WEBHOOK_SECRET = "whsec_test_secret"
function stripeSignature(payload: string): string {
  const ts = Math.floor(Date.now() / 1000)
  const signed = `${ts}.${payload}`
  const v1 = createHmac("sha256", STRIPE_WEBHOOK_SECRET)
    .update(signed)
    .digest("hex")
  return `t=${ts},v1=${v1}`
}

function stripeCheckoutPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "evt_checkout_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test",
        mode: "subscription",
        subscription: "sub_test",
        metadata: { userId: "user-1", planVersionId: "pv-1" },
        ...overrides,
      },
    },
  })
}

describe("webhook duplicate catch (SRC-205)", () => {
  beforeEach(() => {
    setEnv({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_PUBLISHABLE_KEY: "pk_test_x",
      STRIPE_WEBHOOK_SECRET,
    })
  })

  it("rethrows a generic DB error instead of acking it as a duplicate", async () => {
    mockDb.billingEvent.create.mockRejectedValueOnce(new Error("db down"))
    const payload = stripeCheckoutPayload()
    await expect(
      handleWebhook("STRIPE", payload, {
        "stripe-signature": stripeSignature(payload),
      })
    ).rejects.toThrow("db down")
    expect(mockActivate).not.toHaveBeenCalled()
  })

  it("treats ONLY a P2002 as a lost race (duplicate ack)", async () => {
    mockDb.billingEvent.create.mockRejectedValueOnce(p2002())
    const payload = stripeCheckoutPayload()
    const result = await handleWebhook("STRIPE", payload, {
      "stripe-signature": stripeSignature(payload),
    })
    expect(result).toMatchObject({ received: true, duplicate: true })
    expect(mockActivate).not.toHaveBeenCalled()
  })
})

describe("Freemius replay window (BIL-088)", () => {
  const secret = "freemius-secret"

  function freemiusPayload(id: string) {
    return JSON.stringify({
      id,
      type: "license.created",
      objects: {
        license: { plan_id: 123 },
        user: { email: "buyer@example.com" },
      },
      data: { license_id: "lic_1" },
    })
  }

  function freemiusHeaders(payload: string) {
    return {
      "x-signature": createHmac("sha256", secret).update(payload).digest("hex"),
    }
  }

  beforeEach(() => {
    setEnv({
      FREEMIUS_SECRET_KEY: secret,
      FREEMIUS_PLAN_MAP: JSON.stringify({ "pv-1": "123" }),
    })
    store.users.set("buyer-1", { id: "buyer-1", email: "buyer@example.com" })
  })

  it("rejects a redelivery of an already-applied event older than 10 minutes", async () => {
    const payload = freemiusPayload("fs-evt-old")
    // Both clocks explicit: seedEvent defaults createdAt to a fixed
    // date, which crosses the 10-minute window as wall-clock time
    // advances and would make this test time-dependent.
    const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000)
    seedEvent({
      provider: "FREEMIUS",
      providerEventId: "fs-evt-old",
      eventType: "license.created",
      processedAt: elevenMinAgo,
      createdAt: elevenMinAgo,
    })
    await expect(
      handleWebhook("FREEMIUS", payload, freemiusHeaders(payload))
    ).rejects.toMatchObject({ status: 409 })
    expect(mockActivate).not.toHaveBeenCalled()
  })

  it("dedupes a redelivery inside the window (duplicate ack, never re-applied)", async () => {
    const payload = freemiusPayload("fs-evt-recent")
    // Both clocks explicit (see the test above): the fixed
    // seedEvent createdAt default would age out of the window as
    // wall-clock time advances.
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000)
    seedEvent({
      provider: "FREEMIUS",
      providerEventId: "fs-evt-recent",
      eventType: "license.created",
      processedAt: fiveMinAgo,
      createdAt: fiveMinAgo,
    })
    const result = await handleWebhook(
      "FREEMIUS",
      payload,
      freemiusHeaders(payload)
    )
    expect(result).toMatchObject({ received: true, duplicate: true })
    expect(mockActivate).not.toHaveBeenCalled()
  })

  it("lets a never-applied delivery through (processedAt null)", async () => {
    const payload = freemiusPayload("fs-evt-unprocessed")
    seedEvent({
      provider: "FREEMIUS",
      providerEventId: "fs-evt-unprocessed",
      eventType: "license.created",
      processedAt: null,
    })
    const result = await handleWebhook(
      "FREEMIUS",
      payload,
      freemiusHeaders(payload)
    )
    expect(result).toMatchObject({ received: true })
    expect(mockActivate).toHaveBeenCalledTimes(1)
  })
})

describe("Freemius buyer resolution (SRC-207)", () => {
  const secret = "freemius-secret"

  function freemiusPayload(email: string) {
    return JSON.stringify({
      id: `fs-evt-${email}`,
      type: "license.created",
      objects: {
        license: { plan_id: 123 },
        user: { email },
      },
      data: { license_id: "lic_1" },
    })
  }

  beforeEach(() => {
    setEnv({
      FREEMIUS_SECRET_KEY: secret,
      FREEMIUS_PLAN_MAP: JSON.stringify({ "pv-1": "123" }),
    })
  })

  it("activates when the buyer email differs only in case", async () => {
    store.users.set("buyer-1", { id: "buyer-1", email: "Buyer@Example.com" })
    const payload = freemiusPayload("BUYER@EXAMPLE.COM")
    const signature = createHmac("sha256", secret).update(payload).digest("hex")
    const result = await handleWebhook("FREEMIUS", payload, {
      "x-signature": signature,
    })
    expect(result).toMatchObject({ received: true })
    expect(mockActivate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "buyer-1" })
    )
  })

  it("leaves an unresolvable buyer unprocessed with a 422 — never silently ignored", async () => {
    const payload = freemiusPayload("ghost@example.com")
    const signature = createHmac("sha256", secret).update(payload).digest("hex")
    await expect(
      handleWebhook("FREEMIUS", payload, { "x-signature": signature })
    ).rejects.toMatchObject({ status: 422 })
    // The BillingEvent row exists but was never stamped processed —
    // it stays visible in the admin events list.
    const row = store.events.get("FREEMIUS:fs-evt-ghost@example.com")
    expect(row).toBeDefined()
    expect(row?.processedAt).toBeNull()
  })
})

describe("Stripe refund / update / one-time mapping (BIL-003/004/005/081)", () => {
  beforeEach(() => {
    setEnv({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_PUBLISHABLE_KEY: "pk_test_x",
      STRIPE_WEBHOOK_SECRET,
    })
  })

  function refundPayload(refunded: number, amount: number) {
    return JSON.stringify({
      id: "evt_refund_1",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          amount,
          amount_refunded: refunded,
          payment_intent: "pi_1",
          invoice: { subscription: "sub_test" },
        },
      },
    })
  }

  it("a full Stripe refund calls applyRefund with fullRefund: true", async () => {
    const payload = refundPayload(9900, 9900)
    const result = await handleWebhook("STRIPE", payload, {
      "stripe-signature": stripeSignature(payload),
    })
    expect(result).toMatchObject({ received: true, kind: "payment-refunded" })
    expect(mockApplyRefund).toHaveBeenCalledWith(
      "STRIPE",
      expect.objectContaining({
        providerSubscriptionId: "sub_test",
        providerReference: "pi_1",
        fullRefund: true,
        amountMinor: 9900,
      })
    )
  })

  it("a partial Stripe refund calls applyRefund with fullRefund: false", async () => {
    const payload = refundPayload(2000, 9900)
    await handleWebhook("STRIPE", payload, {
      "stripe-signature": stripeSignature(payload),
    })
    expect(mockApplyRefund).toHaveBeenCalledWith(
      "STRIPE",
      expect.objectContaining({ fullRefund: false, amountMinor: 2000 })
    )
  })

  it("a Stripe subscription.updated syncs instead of being ignored", async () => {
    const payload = JSON.stringify({
      id: "evt_sub_upd_1",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_test",
          status: "active",
          // Stripe API 2025+ (SDK v23): the period lives on the
          // subscription item, not on the subscription itself.
          items: { data: [{ current_period_end: 1798761600 }] },
          cancel_at_period_end: true,
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
    expect(mockSync).toHaveBeenCalledWith(
      "STRIPE",
      "sub_test",
      expect.objectContaining({
        status: "active",
        cancelAtPeriodEnd: true,
        periodEnd: new Date(1798761600 * 1000),
      })
    )
  })

  it("a one-time Stripe checkout grants with isOneTime + payment reference (BIL-003)", async () => {
    const payload = stripeCheckoutPayload({
      mode: "payment",
      subscription: null,
      payment_intent: "pi_onetime_1",
    })
    const result = await handleWebhook("STRIPE", payload, {
      "stripe-signature": stripeSignature(payload),
    })
    expect(result).toMatchObject({ received: true, kind: "checkout-completed" })
    expect(mockActivate).toHaveBeenCalledWith({
      userId: "user-1",
      planVersionId: "pv-1",
      provider: "STRIPE",
      providerSubscriptionId: "pi_onetime_1",
      periodEnd: null,
      isOneTime: true,
      providerReference: "pi_onetime_1",
      checkoutId: "cs_test",
    })
  })

  it("a renewal passes the webhook event id to extend (DB-010)", async () => {
    const payload = JSON.stringify({
      id: "evt_invoice_paid_1",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_1",
          subscription: "sub_test",
          lines: {
            data: [
              {
                subscription: "sub_test",
                period: { end: 1798761600 },
              },
            ],
          },
        },
      },
    })
    await handleWebhook("STRIPE", payload, {
      "stripe-signature": stripeSignature(payload),
    })
    expect(mockExtend).toHaveBeenCalledWith(
      "STRIPE",
      "sub_test",
      new Date(1798761600 * 1000),
      "evt_invoice_paid_1"
    )
  })

  it("a paid checkout with no metadata is left unprocessed (BIL-100)", async () => {
    const payload = stripeCheckoutPayload({ metadata: {} })
    const result = await handleWebhook("STRIPE", payload, {
      "stripe-signature": stripeSignature(payload),
    })
    expect(result).toMatchObject({
      received: true,
      kind: "unmapped-payment",
    })
    expect(mockActivate).not.toHaveBeenCalled()
    const row = store.events.get("STRIPE:evt_checkout_1")
    expect(row).toBeDefined()
    expect(row?.processedAt).toBeNull()
  })
})

describe("webhook event ids are content hashes, not Date.now() (SRC-212)", () => {
  const secret = "freemius-secret"

  // Freemius payloads WITHOUT an `id` field: the event id falls
  // back to a SHA-256 content hash. Two distinct deliveries must
  // NOT collide (the old Date.now() fallback dropped the second
  // one as a duplicate when both landed in the same millisecond),
  // while a redelivery of the same payload dedupes to the same id.
  function noIdPayload(licenseId: string) {
    return JSON.stringify({
      type: "license.created",
      objects: {
        license: { plan_id: 123 },
        user: { email: "buyer@example.com" },
      },
      data: { license_id: licenseId },
    })
  }

  beforeEach(() => {
    setEnv({
      FREEMIUS_SECRET_KEY: secret,
      FREEMIUS_PLAN_MAP: JSON.stringify({ "pv-1": "123" }),
    })
    store.users.set("buyer-1", { id: "buyer-1", email: "buyer@example.com" })
  })

  function headers(payload: string) {
    return {
      "x-signature": createHmac("sha256", secret).update(payload).digest("hex"),
    }
  }

  it("applies two distinct no-id deliveries (different content hashes)", async () => {
    const first = noIdPayload("lic_a")
    const second = noIdPayload("lic_b")
    await handleWebhook("FREEMIUS", first, headers(first))
    await handleWebhook("FREEMIUS", second, headers(second))
    expect(mockActivate).toHaveBeenCalledTimes(2)
    expect(store.events.size).toBe(2)
  })

  it("dedupes a redelivery of the same no-id payload", async () => {
    const payload = noIdPayload("lic_a")
    await handleWebhook("FREEMIUS", payload, headers(payload))
    const second = await handleWebhook("FREEMIUS", payload, headers(payload))
    expect(second).toMatchObject({ received: true, duplicate: true })
    expect(mockActivate).toHaveBeenCalledTimes(1)
  })
})

describe("checkout country enforcement (BIL-121)", () => {
  const session = makeSession()

  beforeEach(() => {
    setEnv({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_PUBLISHABLE_KEY: "pk_test_x",
      // requireProviderAvailable also checks the webhook secret —
      // a checkout test needs the provider fully "configured".
      STRIPE_WEBHOOK_SECRET: "whsec_test_x",
      NEXT_PUBLIC_DASHBOARD_URL: "http://localhost:3002",
    })
    seedVersion()
    seedConfig("STRIPE", true, ["US"])
  })

  it("422s when the claimed country contradicts the detected country", async () => {
    await expect(
      createCheckoutSession(
        session,
        { planVersionId: "pv-1", provider: "STRIPE", countryCode: "US" },
        { detectedCountry: "PK" }
      )
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("Country mismatch"),
    })
    expect(mockCreateCheckout).not.toHaveBeenCalled()
  })

  it("422s when the detected country is not served by the provider", async () => {
    await expect(
      createCheckoutSession(
        session,
        { planVersionId: "pv-1", provider: "STRIPE", countryCode: "PK" },
        { detectedCountry: "PK" }
      )
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("not available in your country"),
    })
    expect(mockCreateCheckout).not.toHaveBeenCalled()
  })

  it("honours the manual country when detection is null", async () => {
    await expect(
      createCheckoutSession(
        session,
        { planVersionId: "pv-1", provider: "STRIPE", countryCode: "PK" },
        { detectedCountry: null }
      )
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("not available in your country"),
    })
    expect(mockCreateCheckout).not.toHaveBeenCalled()
  })

  it("checks out when the detected country matches the claim", async () => {
    const result = await createCheckoutSession(
      session,
      { planVersionId: "pv-1", provider: "STRIPE", countryCode: "US" },
      { detectedCountry: "US" }
    )
    expect(result.checkoutUrl).toBe("https://checkout.example.test/pay")
    expect(mockCreateCheckout).toHaveBeenCalledTimes(1)
  })

  it("uses the detected country when the client sends none", async () => {
    const result = await createCheckoutSession(
      session,
      { planVersionId: "pv-1", provider: "STRIPE" },
      { detectedCountry: "US" }
    )
    expect(result.checkoutUrl).toBe("https://checkout.example.test/pay")
  })
})
