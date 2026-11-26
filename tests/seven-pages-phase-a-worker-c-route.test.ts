// Phase A Worker C — Trials stats route gate (plan §3.4).
// GET /api/v1/admin/trials/stats is thin (requireAdminApi VIEW_USERS
// + rate limit + getTrialStats); no test hits the real DB.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockSession = { user: { id: "admin-1" } }
const mockRequireAdminApi = vi.hoisted(() => vi.fn(async () => mockSession))
const mockEnforceRateLimit = vi.hoisted(() =>
  vi.fn(async (): Promise<import("next/server").NextResponse | null> => null)
)
vi.mock("@/lib/require-admin-api", () => ({
  requireAdminApi: mockRequireAdminApi,
}))
vi.mock("@/lib/rate-limit", () => ({
  enforceAdminApiRateLimit: mockEnforceRateLimit,
}))

const mockGetTrialStats = vi.hoisted(() =>
  vi.fn(async () => ({
    activeTrials: 3,
    expiringSoon: 1,
    convertedLast30Days: 2,
    expiredLast30Days: 0,
  }))
)
vi.mock("@sendcms/plans", () => ({
  getTrialStats: mockGetTrialStats,
}))

import { NextRequest, NextResponse } from "next/server"
import { ApiError } from "@sendcms/api-client"
import { GET } from "../apps/api/app/api/v1/admin/trials/stats/route"

const STATS_URL = "http://localhost:3001/api/v1/admin/trials/stats"

function get(url: string) {
  return new NextRequest(url, { method: "GET" })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/v1/admin/trials/stats", () => {
  it("returns the stats and gates on VIEW_USERS", async () => {
    const res = await GET(get(STATS_URL))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      activeTrials: 3,
      expiringSoon: 1,
      convertedLast30Days: 2,
      expiredLast30Days: 0,
    })
    expect(mockRequireAdminApi).toHaveBeenCalledWith("VIEW_USERS")
    expect(mockGetTrialStats).toHaveBeenCalledWith(mockSession)
  })

  it("returns 403 when the actor lacks VIEW_USERS", async () => {
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Forbidden", 403))
    const res = await GET(get(STATS_URL))
    expect(res.status).toBe(403)
    expect(mockGetTrialStats).not.toHaveBeenCalled()
  })

  it("returns the rate-limit response instead of the stats", async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(
      new NextResponse(null, { status: 429 })
    )
    const res = await GET(get(STATS_URL))
    expect(res.status).toBe(429)
    expect(mockGetTrialStats).not.toHaveBeenCalled()
  })
})
