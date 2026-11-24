// Billing rate-limit route helpers (BIL-008 / BIL-018): the checkout
// route is per-user limited, the public webhook routes are per-IP +
// per-provider limited. The DB-backed counter is mocked — only the
// helper wiring (subjects, limits, 429 shape) is exercised here.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import type { RateLimitResult } from "@sendcms/security"

const mockCheckRateLimit = vi.hoisted(() =>
  vi.fn(async (): Promise<RateLimitResult> => ({
    allowed: true,
    minuteCount: 1,
    hourCount: 1,
  }))
)

vi.mock("@sendcms/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/security")>()
  return {
    ...actual,
    checkRateLimit: mockCheckRateLimit,
    resolveClientIp: () => "203.0.113.7",
  }
})

import {
  enforceBillingCheckoutRateLimit,
  enforceBillingWebhookRateLimit,
} from "../apps/api/lib/rate-limit"

function makeRequest(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckRateLimit.mockResolvedValue({
    allowed: true,
    minuteCount: 1,
    hourCount: 1,
  })
})

describe("enforceBillingCheckoutRateLimit (BIL-018)", () => {
  it("allows a checkout under the limit, keyed per user", async () => {
    const result = await enforceBillingCheckoutRateLimit(
      makeRequest("/api/v1/billing/checkout"),
      "user-1"
    )
    expect(result).toBeNull()
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "billing-checkout:user:user-1",
        minuteLimit: 10,
        hourLimit: 10,
      })
    )
  })

  it("returns 429 with Retry-After once the user is over the limit", async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 42,
      minuteCount: 11,
      hourCount: 11,
    })
    const result = await enforceBillingCheckoutRateLimit(
      makeRequest("/api/v1/billing/checkout"),
      "user-1"
    )
    expect(result?.status).toBe(429)
    expect(result?.headers.get("Retry-After")).toBe("42")
  })
})

describe("enforceBillingWebhookRateLimit (BIL-008)", () => {
  it("allows a delivery under the limit, keyed per provider + IP", async () => {
    const result = await enforceBillingWebhookRateLimit(
      makeRequest("/api/public/v1/billing/webhooks/paypal"),
      "PAYPAL"
    )
    expect(result).toBeNull()
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "billing-webhook:paypal:ip:203.0.113.7",
        minuteLimit: 60,
        hourLimit: 600,
      })
    )
  })

  it("returns 429 once one IP floods one webhook endpoint", async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 30,
      minuteCount: 61,
      hourCount: 61,
    })
    const result = await enforceBillingWebhookRateLimit(
      makeRequest("/api/public/v1/billing/webhooks/paypal"),
      "PAYPAL"
    )
    expect(result?.status).toBe(429)
    expect(result?.headers.get("Retry-After")).toBe("30")
  })

  it("scopes buckets per provider, so a Stripe flood does not block PayPal", async () => {
    await enforceBillingWebhookRateLimit(
      makeRequest("/api/public/v1/billing/webhooks/stripe"),
      "STRIPE"
    )
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "billing-webhook:stripe:ip:203.0.113.7",
      })
    )
  })
})
