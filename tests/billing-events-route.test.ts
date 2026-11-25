// Phase 16, Wave 5 — Stream A.
//
// ADM-123 / BIL-123 / BIL-092: GET /api/v1/admin/billing/events — the
// admin billing-events list (paginated, filterable by provider /
// event type / processed state / date).
//
// BIL-128: PATCH /api/v1/admin/billing/providers/[provider] without
// a `reason` fails with the validator's "A reason is required", not
// Zod's raw invalid_type text. The schema half was already pinned by
// ADM-125 in tests/billing.test.ts; this file pins the route half —
// the 422 the admin actually sees.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockSession = { user: { id: "admin-1" } }
const mockRequireAdminApi = vi.hoisted(() => vi.fn(async () => mockSession))
const mockEnforceRateLimit = vi.hoisted(() => vi.fn(async () => null))
vi.mock("@/lib/require-admin-api", () => ({
  requireAdminApi: mockRequireAdminApi,
}))
vi.mock("@/lib/rate-limit", () => ({
  enforceAdminApiRateLimit: mockEnforceRateLimit,
}))

const mockListBillingEvents = vi.hoisted(() =>
  vi.fn(async () => ({
    events: [],
    total: 0,
    page: 1,
    perPage: 20,
    totalPages: 1,
  }))
)
const mockSetProviderConfig = vi.hoisted(() =>
  vi.fn(async () => ({ provider: "STRIPE" }))
)
vi.mock("@sendcms/billing", () => ({
  listBillingEvents: mockListBillingEvents,
  setProviderConfig: mockSetProviderConfig,
}))

import { NextRequest } from "next/server"
import { GET as eventsGET } from "../apps/api/app/api/v1/admin/billing/events/route"
import { PATCH as providerPATCH } from "../apps/api/app/api/v1/admin/billing/providers/[provider]/route"

const EVENTS_URL = "http://localhost:3001/api/v1/admin/billing/events"

function get(url: string) {
  return new NextRequest(url, { method: "GET" })
}

function patch(provider: string, payload: unknown) {
  return new NextRequest(
    `http://localhost:3001/api/v1/admin/billing/providers/${provider}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/v1/admin/billing/events (ADM-123 / BIL-123 / BIL-092)", () => {
  it("returns the paged list with defaults and passes the session", async () => {
    const res = await eventsGET(get(EVENTS_URL))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      events: [],
      total: 0,
      page: 1,
      perPage: 20,
      totalPages: 1,
    })
    expect(mockListBillingEvents).toHaveBeenCalledWith(mockSession, {
      page: 1,
      perPage: 20,
    })
  })

  it("passes provider / eventType / processed filters to the service", async () => {
    const res = await eventsGET(
      get(
        `${EVENTS_URL}?provider=STRIPE&eventType=payment_intent.succeeded&processed=false`
      )
    )
    expect(res.status).toBe(200)
    expect(mockListBillingEvents).toHaveBeenCalledWith(mockSession, {
      page: 1,
      perPage: 20,
      provider: "STRIPE",
      eventType: "payment_intent.succeeded",
      processed: false,
    })
  })

  it("422s on an unparseable to date without calling the service", async () => {
    const res = await eventsGET(get(`${EVENTS_URL}?to=garbage`))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: "Invalid to date" })
    expect(mockListBillingEvents).not.toHaveBeenCalled()
  })

  it("422s on an unknown provider without calling the service", async () => {
    const res = await eventsGET(get(`${EVENTS_URL}?provider=NOPE`))
    expect(res.status).toBe(422)
    expect(mockListBillingEvents).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/v1/admin/billing/providers/[provider] (BIL-128)", () => {
  it("422s with 'A reason is required' when reason is omitted", async () => {
    const res = await providerPATCH(patch("stripe", { isEnabled: true }), {
      params: Promise.resolve({ provider: "stripe" }),
    })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: "A reason is required" })
    expect(mockSetProviderConfig).not.toHaveBeenCalled()
  })

  it("422s with a reason message when reason is an empty string", async () => {
    const res = await providerPATCH(
      patch("stripe", { isEnabled: true, reason: "   " }),
      {
        params: Promise.resolve({ provider: "stripe" }),
      }
    )
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: "A reason is required" })
    expect(mockSetProviderConfig).not.toHaveBeenCalled()
  })

  it("passes a reasoned body to the service", async () => {
    const body = { isEnabled: false, reason: "test" }
    const res = await providerPATCH(patch("stripe", body), {
      params: Promise.resolve({ provider: "stripe" }),
    })
    expect(res.status).toBe(200)
    expect(mockSetProviderConfig).toHaveBeenCalledWith(
      mockSession,
      "STRIPE",
      body
    )
  })
})
