// Phase 16, Wave 6 — Stream A (customer billing routes).
//
// POST /api/v1/billing/subscription (BIL-120 free subscribe),
// POST /api/v1/billing/subscription/cancel (BIL-122 / BIL-091),
// GET /api/v1/billing/usage (BIL-124 / AIM-014),
// GET /api/v1/billing/events (BIL-092 completion),
// GET /api/v1/ai/usage (AIM-014).
//
// Route shape only — auth, validation, and service wiring, with the
// services mocked. No test hits the real DB.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockAuth = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth", () => ({ auth: mockAuth }))

const mockSubscribeToFreePlan = vi.hoisted(() => vi.fn())
const mockGetMySubscription = vi.hoisted(() => vi.fn())
const mockCancelMySubscription = vi.hoisted(() => vi.fn())
const mockGetMyUsage = vi.hoisted(() => vi.fn())
vi.mock("@sendcms/plans", () => ({
  subscribeToFreePlan: mockSubscribeToFreePlan,
  getMySubscription: mockGetMySubscription,
  cancelMySubscription: mockCancelMySubscription,
  getMyUsage: mockGetMyUsage,
}))

const mockListMyBillingEvents = vi.hoisted(() => vi.fn())
const mockCancelSubscriptionAtProvider = vi.hoisted(() => vi.fn())
vi.mock("@sendcms/billing", () => ({
  listMyBillingEvents: mockListMyBillingEvents,
  // DSH-402 / BIL-001 (Wave 8): the cancel route passes the
  // provider-cancel dispatcher into cancelMySubscription, so the
  // mock must export it or Vitest throws on the missing export.
  cancelSubscriptionAtProvider: mockCancelSubscriptionAtProvider,
}))

const mockGetMyAiUsage = vi.hoisted(() => vi.fn())
vi.mock("@sendcms/ai-settings", () => ({
  getMyAiUsage: mockGetMyAiUsage,
}))

import { NextRequest } from "next/server"
import {
  GET as getSubscription,
  POST as subscribe,
} from "../apps/api/app/api/v1/billing/subscription/route"
import { POST as cancel } from "../apps/api/app/api/v1/billing/subscription/cancel/route"
import { GET as getUsage } from "../apps/api/app/api/v1/billing/usage/route"
import { GET as getMyEvents } from "../apps/api/app/api/v1/billing/events/route"
import { GET as getMyAiUsage } from "../apps/api/app/api/v1/ai/usage/route"

const BASE = "http://localhost:3001"

function post(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function get(url: string) {
  return new NextRequest(url, { method: "GET" })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "user-1" } })
  mockSubscribeToFreePlan.mockResolvedValue({
    id: "sub-1",
    status: "ACTIVE",
  })
  mockGetMySubscription.mockResolvedValue(null)
  mockCancelMySubscription.mockResolvedValue({
    id: "sub-1",
    status: "CANCELED",
  })
  mockGetMyUsage.mockResolvedValue({ subscription: null, meters: {} })
  mockListMyBillingEvents.mockResolvedValue({
    events: [],
    total: 0,
    page: 1,
    perPage: 20,
    totalPages: 1,
  })
  mockGetMyAiUsage.mockResolvedValue({
    billingMode: "PLATFORM",
    allowance: { allowed: true, limit: 100, used: 0, remaining: 100 },
    today: { byok: {}, platform: {}, total: {} },
    totalCostMicros: 0,
  })
})

describe("POST /api/v1/billing/subscription (BIL-120)", () => {
  it("subscribes the signed-in user to the free version", async () => {
    const res = await subscribe(
      post(`${BASE}/api/v1/billing/subscription`, {
        planVersionId: "pv-free",
      })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "sub-1", status: "ACTIVE" })
    expect(mockSubscribeToFreePlan).toHaveBeenCalledWith("user-1", {
      planVersionId: "pv-free",
    })
  })

  it("401s when unauthenticated without calling the service", async () => {
    mockAuth.mockResolvedValue(null)
    const res = await subscribe(
      post(`${BASE}/api/v1/billing/subscription`, {
        planVersionId: "pv-free",
      })
    )
    expect(res.status).toBe(401)
    expect(mockSubscribeToFreePlan).not.toHaveBeenCalled()
  })

  it("422s when planVersionId is missing", async () => {
    const res = await subscribe(post(`${BASE}/api/v1/billing/subscription`, {}))
    expect(res.status).toBe(422)
    expect(mockSubscribeToFreePlan).not.toHaveBeenCalled()
  })
})

describe("GET /api/v1/billing/subscription (unchanged)", () => {
  it("still returns the caller's subscription", async () => {
    mockGetMySubscription.mockResolvedValue({ id: "sub-1" })
    const res = await getSubscription()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "sub-1" })
    expect(mockGetMySubscription).toHaveBeenCalledWith("user-1")
  })
})

describe("POST /api/v1/billing/subscription/cancel (BIL-122 / BIL-091)", () => {
  it("cancels the caller's own subscription, at period end when asked", async () => {
    const res = await cancel(
      post(`${BASE}/api/v1/billing/subscription/cancel`, {
        cancelAtPeriodEnd: true,
      })
    )
    expect(res.status).toBe(200)
    expect(mockCancelMySubscription).toHaveBeenCalledWith(
      "user-1",
      {
        cancelAtPeriodEnd: true,
      },
      { cancelAtProvider: mockCancelSubscriptionAtProvider }
    )
  })

  it("defaults to an immediate cancel with an empty body", async () => {
    const res = await cancel(
      post(`${BASE}/api/v1/billing/subscription/cancel`, {})
    )
    expect(res.status).toBe(200)
    expect(mockCancelMySubscription).toHaveBeenCalledWith(
      "user-1",
      {
        cancelAtPeriodEnd: false,
      },
      { cancelAtProvider: mockCancelSubscriptionAtProvider }
    )
  })

  it("401s when unauthenticated without calling the service", async () => {
    mockAuth.mockResolvedValue(null)
    const res = await cancel(
      post(`${BASE}/api/v1/billing/subscription/cancel`, {})
    )
    expect(res.status).toBe(401)
    expect(mockCancelMySubscription).not.toHaveBeenCalled()
  })
})

describe("GET /api/v1/billing/usage (BIL-124 / AIM-014)", () => {
  it("returns the caller's usage only", async () => {
    const res = await getUsage()
    expect(res.status).toBe(200)
    expect(mockGetMyUsage).toHaveBeenCalledWith("user-1")
  })

  it("401s when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null)
    const res = await getUsage()
    expect(res.status).toBe(401)
    expect(mockGetMyUsage).not.toHaveBeenCalled()
  })
})

describe("GET /api/v1/billing/events (BIL-092 completion)", () => {
  it("lists the caller's events with defaults and passes the session user", async () => {
    const res = await getMyEvents(get(`${BASE}/api/v1/billing/events`))
    expect(res.status).toBe(200)
    expect(mockListMyBillingEvents).toHaveBeenCalledWith("user-1", {
      page: 1,
      perPage: 20,
    })
  })

  it("422s on an unparseable to date without calling the service", async () => {
    const res = await getMyEvents(
      get(`${BASE}/api/v1/billing/events?to=garbage`)
    )
    expect(res.status).toBe(422)
    expect(mockListMyBillingEvents).not.toHaveBeenCalled()
  })

  it("401s when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null)
    const res = await getMyEvents(get(`${BASE}/api/v1/billing/events`))
    expect(res.status).toBe(401)
    expect(mockListMyBillingEvents).not.toHaveBeenCalled()
  })
})

describe("GET /api/v1/ai/usage (AIM-014)", () => {
  it("returns the caller's AI usage only", async () => {
    const res = await getMyAiUsage()
    expect(res.status).toBe(200)
    expect(mockGetMyAiUsage).toHaveBeenCalledWith("user-1")
  })

  it("401s when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null)
    const res = await getMyAiUsage()
    expect(res.status).toBe(401)
    expect(mockGetMyAiUsage).not.toHaveBeenCalled()
  })
})
