// Phase 16, Wave 4 — Stream B.
//
// SDK-031: wrong-method requests used to get Next.js's empty 405 with
// no `Allow` header, and unknown public paths got an HTML 404. Public
// routes now export their unimplemented methods as JSON 405s, and a
// catch-all answers unknown /api/public/v1/* paths with a JSON 404.
import { describe, expect, it, vi } from "vitest"

const mockSubmitForm = vi.hoisted(() => vi.fn())
const mockProcessOutbox = vi.hoisted(() => vi.fn(async () => ({})))
const mockAfter = vi.hoisted(() => vi.fn())
const mockIsVerifiedOrigin = vi.hoisted(() => vi.fn(async () => true))
vi.mock("@sendcms/submissions", () => ({
  submitForm: mockSubmitForm,
}))
vi.mock("@sendcms/domains", () => ({
  isVerifiedOrigin: mockIsVerifiedOrigin,
}))
vi.mock("@sendcms/notifications", () => ({
  processEmailOutbox: mockProcessOutbox,
}))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: mockAfter }
})

const mockListPublishedPlans = vi.hoisted(() => vi.fn(async () => []))
const mockListPublicCountries = vi.hoisted(() =>
  vi.fn(async () => [{ code: "US", name: "United States" }])
)
const mockHandleWebhook = vi.hoisted(() => vi.fn(async () => ({ ok: true })))
const mockEnforceWebhookRateLimit = vi.hoisted(() => vi.fn(async () => null))
vi.mock("@sendcms/plans", () => ({
  listPublishedPlans: mockListPublishedPlans,
}))
vi.mock("@sendcms/billing", () => ({
  listPublicCountries: mockListPublicCountries,
  handleWebhook: mockHandleWebhook,
}))
vi.mock("@/lib/rate-limit", () => ({
  enforceBillingWebhookRateLimit: mockEnforceWebhookRateLimit,
}))

import { NextRequest } from "next/server"
import {
  GET as plansGET,
  POST as plansPOST,
  PUT as plansPUT,
  DELETE as plansDELETE,
  OPTIONS as plansOPTIONS,
} from "../apps/api/app/api/public/v1/plans/route"
import {
  GET as countriesGET,
  POST as countriesPOST,
} from "../apps/api/app/api/public/v1/billing/countries/route"
import {
  POST as stripePOST,
  GET as stripeGET,
  DELETE as stripeDELETE,
  OPTIONS as stripeOPTIONS,
} from "../apps/api/app/api/public/v1/billing/webhooks/stripe/route"
import {
  GET as submitGET,
  PUT as submitPUT,
} from "../apps/api/app/api/public/v1/submit/route"
import {
  GET as unmatchedGET,
  POST as unmatchedPOST,
  DELETE as unmatchedDELETE,
} from "../apps/api/app/api/public/v1/[...unmatched]/route"

const STRIPE_URL = "http://localhost:3001/api/public/v1/billing/webhooks/stripe"

describe("SDK-031 wrong-method 405s", () => {
  it("GET /submit is a JSON 405 with Allow: POST, OPTIONS", async () => {
    const res = await submitGET()
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("POST, OPTIONS")
    expect(await res.json()).toEqual({ error: "Method not allowed" })
  })

  it("PUT /submit is a JSON 405 with the same Allow", async () => {
    const res = await submitPUT()
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("POST, OPTIONS")
    expect(await res.json()).toEqual({ error: "Method not allowed" })
  })

  it("POST /plans is a JSON 405 with Allow: GET", async () => {
    const res = await plansPOST()
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("GET")
    expect(await res.json()).toEqual({ error: "Method not allowed" })
  })

  it("PUT /plans is a JSON 405 with Allow: GET", async () => {
    const res = await plansPUT()
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("GET")
  })

  it("DELETE and OPTIONS /plans are JSON 405s with Allow: GET", async () => {
    for (const fn of [plansDELETE, plansOPTIONS]) {
      const res = await fn()
      expect(res.status).toBe(405)
      expect(res.headers.get("allow")).toBe("GET")
      expect(await res.json()).toEqual({ error: "Method not allowed" })
    }
  })

  it("POST /billing/countries is a JSON 405 with Allow: GET", async () => {
    const res = await countriesPOST()
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("GET")
    expect(await res.json()).toEqual({ error: "Method not allowed" })
  })

  it("GET /billing/webhooks/stripe is a JSON 405 with Allow: POST", async () => {
    const res = await stripeGET()
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("POST")
    expect(await res.json()).toEqual({ error: "Method not allowed" })
    expect(mockHandleWebhook).not.toHaveBeenCalled()
  })

  it("DELETE and OPTIONS on the Stripe webhook are JSON 405s with Allow: POST", async () => {
    for (const fn of [stripeDELETE, stripeOPTIONS]) {
      const res = await fn()
      expect(res.status).toBe(405)
      expect(res.headers.get("allow")).toBe("POST")
    }
  })

  it("the real methods still work (catch-all does not shadow static routes)", async () => {
    const plans = await plansGET()
    expect(plans.status).toBe(200)
    expect(await plans.json()).toEqual([])
    const countries = await countriesGET()
    expect(countries.status).toBe(200)
    expect(await countries.json()).toEqual([
      { code: "US", name: "United States" },
    ])
    const hook = await stripePOST(
      new NextRequest(STRIPE_URL, { method: "POST", body: "{}" })
    )
    expect(hook.status).toBe(200)
    expect(mockHandleWebhook).toHaveBeenCalledWith(
      "STRIPE",
      "{}",
      expect.anything()
    )
  })
})

describe("SDK-031 unknown public path 404s", () => {
  it("GET /api/public/v1/nope is a JSON 404", async () => {
    const res = await unmatchedGET()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Not found" })
  })

  it("POST and DELETE on an unknown path are JSON 404s too", async () => {
    for (const fn of [unmatchedPOST, unmatchedDELETE]) {
      const res = await fn()
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: "Not found" })
    }
  })
})
