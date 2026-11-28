// Phase 17 findings fix, Stream E — DOC-062: the unconfigured-Polar
// status depends on which value is missing, and the two branches must
// not be conflated:
//   - missing POLAR_WEBHOOK_SECRET → 503 "Polar is not configured"
//     (verifyPolarWebhook, polar.ts:284 — a server-side
//     misconfiguration the provider retries, BIL-101);
//   - missing POLAR_ACCESS_TOKEN → 422 "Polar is not configured"
//     (getClient, polar.ts:34 — before any SDK call).
// The Polar SDK is mocked at the module level, and the env vars are
// unset in the test — no test hits the real DB, a real provider, or
// the network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
import {
  createPolarCheckoutSession,
  verifyPolarWebhook,
} from "../packages/modules/billing/src/providers/polar"

const version = {
  id: "pv-1",
  planId: "plan-1",
  planName: "Pro",
  priceAmount: 9900,
  priceCurrency: "USD",
  billingInterval: "MONTHLY" as const,
  trialDays: 0,
}

const checkoutArgs = {
  version,
  customer: { userId: "user-1", email: "user@example.com", name: "User" },
  successUrl: "https://example.com/success",
  cancelUrl: "https://example.com/cancel",
  idempotencyKey: "attempt-123",
}

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  vi.clearAllMocks()
  savedEnv.POLAR_ACCESS_TOKEN = process.env.POLAR_ACCESS_TOKEN
  savedEnv.POLAR_WEBHOOK_SECRET = process.env.POLAR_WEBHOOK_SECRET
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("DOC-062 — unconfigured Polar returns a different status per missing value", () => {
  it("missing webhook secret → 503, even when the access token is set", async () => {
    process.env.POLAR_ACCESS_TOKEN = "polar_test_token"
    delete process.env.POLAR_WEBHOOK_SECRET
    await expect(verifyPolarWebhook("{}", {})).rejects.toMatchObject({
      status: 503,
      message: "Polar is not configured",
    })
  })

  it("missing webhook secret → 503 when the access token is also unset (the dev case)", async () => {
    delete process.env.POLAR_ACCESS_TOKEN
    delete process.env.POLAR_WEBHOOK_SECRET
    await expect(verifyPolarWebhook("{}", {})).rejects.toMatchObject({
      status: 503,
      message: "Polar is not configured",
    })
  })

  it("missing access token → 422 from checkout, before any SDK call", async () => {
    delete process.env.POLAR_ACCESS_TOKEN
    process.env.POLAR_WEBHOOK_SECRET = "whsec_test_secret"
    await expect(
      createPolarCheckoutSession(checkoutArgs)
    ).rejects.toMatchObject({
      status: 422,
      message: "Polar is not configured",
    })
    expect(polarMocks.productsCreate).not.toHaveBeenCalled()
    expect(polarMocks.checkoutsCreate).not.toHaveBeenCalled()
  })
})
