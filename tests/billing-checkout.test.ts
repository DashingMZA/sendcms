// Provider checkout idempotency keys (BIL-014): a retried checkout
// with the same attempt id passes the same per-call key to every
// provider create call, so the provider replays the same objects
// instead of creating duplicates. Stripe is mocked at the module
// level; PayPal is exercised through a stubbed fetch. No test hits
// the real DB, a real provider, or the network.
import { beforeEach, describe, expect, it, vi } from "vitest"

// Stripe is externalized by Vitest (node_modules), so `vi.mock("stripe")`
// never applies to the SUT's import. Instead, spy on the resource
// prototypes of the one shared module instance: the SUT's `new
// Stripe(...)` builds its `prices` / `checkout.sessions` resources
// from these same prototypes, so the spies intercept every call. The
// SUT loads Stripe's ESM build (Node "import" condition), so the spy
// must target that build — the CJS build is a second, separate copy.
const stripeEsm =
  await import("../node_modules/.pnpm/stripe@23.2.0_@types+node@26.6.6/node_modules/stripe/esm/stripe.esm.node.js")
const StripeEsm = stripeEsm.default as new (key: string) => {
  prices: { create: (...args: unknown[]) => Promise<unknown> }
  checkout: { sessions: { create: (...args: unknown[]) => Promise<unknown> } }
}
const stripeProbe = new StripeEsm("sk_test_x")

const mockPricesCreate = vi.fn(async (...args: unknown[]) => {
  void args
  return { id: "price_1" }
})
const mockSessionsCreate = vi.fn(async (...args: unknown[]) => {
  void args
  return {
    id: "cs_1",
    url: "https://checkout.stripe.test/pay",
  }
})

vi.spyOn(
  Object.getPrototypeOf(stripeProbe.prices) as {
    create: (...args: unknown[]) => Promise<unknown>
  },
  "create"
).mockImplementation(mockPricesCreate as never)
vi.spyOn(
  Object.getPrototypeOf(stripeProbe.checkout.sessions) as {
    create: (...args: unknown[]) => Promise<unknown>
  },
  "create"
).mockImplementation(mockSessionsCreate as never)

import { createStripeCheckoutSession } from "../packages/modules/billing/src/providers/stripe"
import {
  createPayPalCheckoutSession,
  resetPayPalTokenCache,
} from "../packages/modules/billing/src/providers/paypal"

// BIL-054: the Polar SDK is mocked at the module level — no test
// hits Polar's API. Only createPolar + webhooks are value imports
// in the provider (Environment/models are types, erased).
const polarMocks = vi.hoisted(() => ({
  productsCreate: vi.fn(),
  checkoutsCreate: vi.fn(),
}))
vi.mock("@polar-sh/sdk/2026-10", () => ({
  createPolar: () => ({
    products: { create: polarMocks.productsCreate },
    checkouts: { create: polarMocks.checkoutsCreate },
    subscriptions: { update: vi.fn(), revoke: vi.fn() },
  }),
  webhooks: { validateEvent: vi.fn() },
}))
import { createPolarCheckoutSession } from "../packages/modules/billing/src/providers/polar"

const version = {
  id: "pv-1",
  planId: "plan-1",
  planName: "Pro",
  priceAmount: 9900,
  priceCurrency: "USD",
  billingInterval: "MONTHLY" as const,
  trialDays: 0,
}

const args = {
  version,
  customer: { userId: "user-1", email: "user@example.com", name: "User" },
  successUrl: "https://example.com/success",
  cancelUrl: "https://example.com/cancel",
  idempotencyKey: "attempt-123",
}

beforeEach(() => {
  vi.clearAllMocks()
  // BIL-022: the PayPal token cache is module-scope — reset it so no
  // test inherits a token minted by an earlier test's stubbed fetch.
  resetPayPalTokenCache()
  process.env.STRIPE_SECRET_KEY = "sk_test_x"
  process.env.PAYPAL_CLIENT_ID = "id"
  process.env.PAYPAL_CLIENT_SECRET = "secret"
  delete process.env.PAYPAL_MODE
})

describe("Stripe checkout idempotency keys", () => {
  it("passes a derived idempotency key to the Price and Session creates", async () => {
    const result = await createStripeCheckoutSession(args)
    expect(result.checkoutUrl).toBe("https://checkout.stripe.test/pay")
    expect(mockPricesCreate).toHaveBeenCalledTimes(1)
    expect(mockPricesCreate.mock.calls[0][1]).toEqual({
      idempotencyKey: "attempt-123:price",
    })
    expect(mockSessionsCreate).toHaveBeenCalledTimes(1)
    expect(mockSessionsCreate.mock.calls[0][1]).toEqual({
      idempotencyKey: "attempt-123:session",
    })
  })

  it("reuses the same keys for a retried checkout with the same attempt id", async () => {
    await createStripeCheckoutSession(args)
    await createStripeCheckoutSession(args)
    expect(mockPricesCreate.mock.calls[0][1]).toEqual(
      mockPricesCreate.mock.calls[1][1]
    )
    expect(mockSessionsCreate.mock.calls[0][1]).toEqual(
      mockSessionsCreate.mock.calls[1][1]
    )
  })
})

describe("PayPal checkout idempotency keys", () => {
  function stubPayPal() {
    const seenRequestIds: { url: string; requestId: string | null }[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (url.endsWith("/v1/oauth2/token")) {
        return { ok: true, json: async () => ({ access_token: "tok" }) }
      }
      seenRequestIds.push({
        url,
        requestId: headers.get("PayPal-Request-Id"),
      })
      if (url.endsWith("/v1/catalogs/products")) {
        return { ok: true, json: async () => ({ id: "prod_1" }) }
      }
      if (url.endsWith("/v1/billing/plans")) {
        return { ok: true, json: async () => ({ id: "plan_1" }) }
      }
      if (url.endsWith("/v1/billing/subscriptions")) {
        return {
          ok: true,
          json: async () => ({
            id: "I-SUB1",
            links: [{ rel: "approve", href: "https://paypal.test/approve" }],
          }),
        }
      }
      if (url.endsWith("/v2/checkout/orders")) {
        return {
          ok: true,
          json: async () => ({
            id: "order_1",
            links: [{ rel: "approve", href: "https://paypal.test/approve" }],
          }),
        }
      }
      throw new Error(`unexpected PayPal URL: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)
    return seenRequestIds
  }

  it("sends PayPal-Request-Id on every recurring create call", async () => {
    const seen = stubPayPal()
    try {
      const result = await createPayPalCheckoutSession(args)
      expect(result.checkoutUrl).toBe("https://paypal.test/approve")
      expect(seen.map((entry) => entry.requestId)).toEqual([
        "attempt-123:product",
        "attempt-123:plan",
        "attempt-123:subscription",
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("sends PayPal-Request-Id on the one-time order create", async () => {
    const seen = stubPayPal()
    try {
      const oneTime = {
        ...args,
        version: { ...version, billingInterval: "ONE_TIME" as const },
      }
      const result = await createPayPalCheckoutSession(oneTime)
      expect(result.checkoutUrl).toBe("https://paypal.test/approve")
      expect(seen.map((entry) => entry.requestId)).toEqual([
        "attempt-123:order",
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // BIL-022: two consecutive checkouts exchange the OAuth token once —
  // the second checkout reuses the cached token until near expiry.
  it("exchanges the PayPal OAuth token once for two consecutive checkouts", async () => {
    resetPayPalTokenCache()
    let tokenCalls = 0
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (url.endsWith("/v1/oauth2/token")) {
        tokenCalls++
        return {
          ok: true,
          json: async () => ({ access_token: "tok", expires_in: 32400 }),
        }
      }
      if (url.endsWith("/v1/catalogs/products")) {
        return { ok: true, json: async () => ({ id: "prod_1" }) }
      }
      if (url.endsWith("/v1/billing/plans")) {
        return { ok: true, json: async () => ({ id: "plan_1" }) }
      }
      if (url.endsWith("/v1/billing/subscriptions")) {
        return {
          ok: true,
          json: async () => ({
            id: "I-SUB1",
            links: [{ rel: "approve", href: "https://paypal.test/approve" }],
          }),
        }
      }
      throw new Error(`unexpected PayPal URL: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)
    try {
      const first = await createPayPalCheckoutSession(args)
      const second = await createPayPalCheckoutSession(args)
      expect(first.checkoutUrl).toBe("https://paypal.test/approve")
      expect(second.checkoutUrl).toBe("https://paypal.test/approve")
      expect(tokenCalls).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// BIL-009: PAYPAL_MODE used to silently mean sandbox for any value
// other than "live" — now an invalid value is a 422 naming it, and
// "live" is matched case-insensitively.
describe("PayPal mode validation (BIL-009)", () => {
  function stubPayPalTokenOnly() {
    const urls: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url)
      if (url.endsWith("/v1/oauth2/token")) {
        return { ok: true, json: async () => ({ access_token: "tok" }) }
      }
      throw new Error(`unexpected PayPal URL: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)
    return urls
  }

  it("throws 422 naming an invalid PAYPAL_MODE before any request", async () => {
    process.env.PAYPAL_MODE = "production"
    try {
      await expect(createPayPalCheckoutSession(args)).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining('Invalid PAYPAL_MODE "production"'),
      })
    } finally {
      delete process.env.PAYPAL_MODE
    }
  })

  it("treats 'Live' as live (case-insensitive, trimmed)", async () => {
    process.env.PAYPAL_MODE = " Live "
    const urls = stubPayPalTokenOnly()
    try {
      await expect(createPayPalCheckoutSession(args)).rejects.toThrow(
        /unexpected PayPal URL/
      )
      expect(urls[0]).toBe("https://api-m.paypal.com/v1/oauth2/token")
    } finally {
      vi.unstubAllGlobals()
      delete process.env.PAYPAL_MODE
    }
  })
})

// BIL-054: POLAR_ENVIRONMENT used to silently mean sandbox for any
// value other than "production" — now an invalid value is a 422, and
// a token/environment mismatch surfaces as a clear 502.
describe("Polar environment validation (BIL-054)", () => {
  beforeEach(() => {
    polarMocks.productsCreate.mockReset()
    polarMocks.checkoutsCreate.mockReset()
    process.env.POLAR_ACCESS_TOKEN = "polar_test_token"
    delete process.env.POLAR_ENVIRONMENT
  })

  it("throws 422 naming an invalid POLAR_ENVIRONMENT before any SDK call", async () => {
    process.env.POLAR_ENVIRONMENT = "prodution"
    try {
      await expect(createPolarCheckoutSession(args)).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining(
          'Invalid POLAR_ENVIRONMENT "prodution"'
        ),
      })
      expect(polarMocks.productsCreate).not.toHaveBeenCalled()
    } finally {
      delete process.env.POLAR_ENVIRONMENT
    }
  })

  it("maps an SDK auth failure to a 502 naming the token/environment mismatch", async () => {
    polarMocks.productsCreate.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 })
    )
    await expect(createPolarCheckoutSession(args)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("matches POLAR_ENVIRONMENT"),
    })
  })

  it("creates the product and checkout on the happy path", async () => {
    polarMocks.productsCreate.mockResolvedValue({ id: "prod_1" })
    polarMocks.checkoutsCreate.mockResolvedValue({
      id: "co_1",
      url: "https://polar.test/checkout",
    })
    const result = await createPolarCheckoutSession(args)
    expect(result.checkoutUrl).toBe("https://polar.test/checkout")
    expect(result.providerCheckoutId).toBe("co_1")
    expect(result.catalog).toEqual({ polarProductId: "prod_1" })
  })
})
