// Phase D Worker B — Coupons admin API routes, capability gates,
// i18n wiring, and page wiring (plan §3.7, Q6/Q10).
// No test hits the real DB, a real provider, or the network: the
// route tests mock the `@sendcms/coupons` service barrel (Worker C
// pattern) and keep the REAL Zod schemas — Stream A's validators
// landed while this stream ran, so bad bodies still 422 for real.
// The service itself (validation matrix, concurrency, redemption
// atomicity) is Stream A's worker-a file; this file pins the route
// layer, the gates, and the wiring this stream owns.
//
// TIME: no test asserts a locale-rendered clock time, so no
// timeZone pinning is needed in an assertion.
//
// PATCH scope (consolidation gap): Stream A ships no updateCoupon /
// UpdateCouponSchema, so the route accepts exactly one PATCH shape —
// { status: "DISABLED" } — and refuses field edits, re-enable, and
// immutable-field changes with 422. The tests below pin that
// behaviour; if Stream A later adds updateCoupon, the PATCH
// describes must be rewritten, not just extended.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { ApiError } from "@sendcms/api-client"
import { PLATFORM_ROUTE_CAPABILITY, adminCan } from "@sendcms/permissions"
import {
  CouponRedemptionsQuerySchema,
  CouponsQuerySchema,
  CreateCouponSchema,
} from "@sendcms/coupons/validators"
import type { CouponRedemptionsResponse } from "@sendcms/coupons/queries"

const root = process.cwd()
const read = (rel: string) => readFileSync(path.join(root, rel), "utf-8")

// ─── Mocks ────────────────────────────────────────────────────────────

const mockSession = { user: { id: "admin-1" } }
const mockRequireAdminApi = vi.hoisted(() => vi.fn(async () => mockSession))
const mockEnforceRateLimit = vi.hoisted(() =>
  vi.fn(async (): Promise<NextResponse | null> => null)
)
const mockListCoupons = vi.hoisted(() =>
  vi.fn(async () => ({
    coupons: [],
    total: 0,
    page: 1,
    perPage: 20,
    totalPages: 1,
  }))
)
const mockGetCoupon = vi.hoisted(() =>
  vi.fn(async () => ({ id: "cp-1", code: "WELCOME10", status: "ACTIVE" }))
)
const mockCreateCoupon = vi.hoisted(() =>
  vi.fn(async () => ({ id: "cp-1", code: "WELCOME10", status: "ACTIVE" }))
)
const mockDisableCoupon = vi.hoisted(() =>
  vi.fn(async () => ({ id: "cp-1", code: "WELCOME10", status: "DISABLED" }))
)
const mockUpdateCoupon = vi.hoisted(() =>
  vi.fn(async () => ({ id: "cp-1", code: "WELCOME10", status: "ACTIVE" }))
)
const mockDeleteCoupon = vi.hoisted(() =>
  vi.fn(async () => ({ id: "cp-1", code: "WELCOME10", status: "DISABLED" }))
)
const mockListCouponRedemptions = vi.hoisted(() =>
  vi.fn(async (): Promise<CouponRedemptionsResponse> => ({
    redemptions: [],
    total: 0,
    page: 1,
    perPage: 20,
    totalPages: 1,
  }))
)

vi.mock("@/lib/require-admin-api", () => ({
  requireAdminApi: mockRequireAdminApi,
}))
vi.mock("@/lib/rate-limit", () => ({
  enforceAdminApiRateLimit: mockEnforceRateLimit,
}))
vi.mock("@sendcms/coupons", () => ({
  listCoupons: mockListCoupons,
  getCoupon: mockGetCoupon,
  createCoupon: mockCreateCoupon,
  disableCoupon: mockDisableCoupon,
  updateCoupon: mockUpdateCoupon,
  deleteCoupon: mockDeleteCoupon,
  listCouponRedemptions: mockListCouponRedemptions,
}))

import {
  DELETE as DELETE_COUPON,
  GET as GET_COUPON,
  PATCH as PATCH_COUPON,
} from "../apps/api/app/api/v1/admin/coupons/[id]/route"
import {
  GET as GET_COUPONS,
  POST as POST_COUPONS,
} from "../apps/api/app/api/v1/admin/coupons/route"
import { GET as GET_REDEMPTIONS } from "../apps/api/app/api/v1/admin/coupons/[id]/redemptions/route"

beforeEach(() => {
  vi.clearAllMocks()
})

function postRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function patchRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

// ─── Validators (real schemas — Stream A) ─────────────────────────────

describe("CouponsQuerySchema", () => {
  it("defaults the tab to all and the page to 1", () => {
    expect(CouponsQuerySchema.parse({})).toEqual({
      page: 1,
      perPage: 20,
      status: "all",
    })
    expect(CouponsQuerySchema.parse({ status: "ACTIVE", page: "2" })).toEqual({
      status: "ACTIVE",
      page: 2,
      perPage: 20,
    })
  })

  it("rejects an unknown status and a bad page", () => {
    expect(CouponsQuerySchema.safeParse({ status: "active" }).success).toBe(
      false
    )
    expect(CouponsQuerySchema.safeParse({ page: 0 }).success).toBe(false)
    expect(CouponsQuerySchema.safeParse({ perPage: 101 }).success).toBe(false)
  })
})

describe("CreateCouponSchema", () => {
  it("upper-cases the code and applies the Q6 defaults", () => {
    const parsed = CreateCouponSchema.parse({
      code: "welcome10",
      discountType: "PERCENT",
      discountValue: 10,
    })
    expect(parsed.code).toBe("WELCOME10")
    expect(parsed.currency).toBe("USD")
    expect(parsed.appliesToPlanIds).toEqual([])
    expect(parsed.firstPurchaseOnly).toBe(false)
  })

  it("rejects a percent over 100 and a non-positive fixed amount", () => {
    expect(
      CreateCouponSchema.safeParse({
        code: "X1Y",
        discountType: "PERCENT",
        discountValue: 101,
      }).success
    ).toBe(false)
    expect(
      CreateCouponSchema.safeParse({
        code: "X1Y",
        discountType: "FIXED",
        discountValue: 0,
      }).success
    ).toBe(false)
    expect(
      CreateCouponSchema.safeParse({
        code: "X1Y",
        discountType: "FIXED",
        discountValue: 2500,
      }).success
    ).toBe(true)
  })

  it("rejects a code with spaces, a short code, and a reversed window", () => {
    expect(
      CreateCouponSchema.safeParse({
        code: "BAD CODE",
        discountType: "PERCENT",
        discountValue: 10,
      }).success
    ).toBe(false)
    expect(
      CreateCouponSchema.safeParse({
        code: "AB",
        discountType: "PERCENT",
        discountValue: 10,
      }).success
    ).toBe(false)
    expect(
      CreateCouponSchema.safeParse({
        code: "OK123",
        discountType: "PERCENT",
        discountValue: 10,
        validFrom: "2026-12-02T00:00:00Z",
        validUntil: "2026-12-01T00:00:00Z",
      }).success
    ).toBe(false)
  })
})

describe("CouponRedemptionsQuerySchema", () => {
  it("defaults to page 1, 20 per page, and rejects page 0", () => {
    expect(CouponRedemptionsQuerySchema.parse({})).toEqual({
      page: 1,
      perPage: 20,
    })
    expect(CouponRedemptionsQuerySchema.safeParse({ page: 0 }).success).toBe(
      false
    )
  })
})

// ─── Routes: GET/POST /api/v1/admin/coupons ───────────────────────────

describe("GET /api/v1/admin/coupons", () => {
  const url = "http://localhost:3001/api/v1/admin/coupons?status=ACTIVE"

  it("returns the list and gates on VIEW_BILLING", async () => {
    const res = await GET_COUPONS(new NextRequest(url))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      coupons: [],
      total: 0,
      page: 1,
      perPage: 20,
      totalPages: 1,
    })
    expect(mockRequireAdminApi).toHaveBeenCalledWith("VIEW_BILLING")
    expect(mockListCoupons).toHaveBeenCalledWith(mockSession, {
      status: "ACTIVE",
      page: 1,
      perPage: 20,
    })
  })

  it("returns 422 for an unknown status without calling the service", async () => {
    const res = await GET_COUPONS(
      new NextRequest(
        "http://localhost:3001/api/v1/admin/coupons?status=active"
      )
    )
    expect(res.status).toBe(422)
    expect(mockListCoupons).not.toHaveBeenCalled()
  })

  it("returns 422 for a bad page without calling the service", async () => {
    const res = await GET_COUPONS(
      new NextRequest("http://localhost:3001/api/v1/admin/coupons?page=0")
    )
    expect(res.status).toBe(422)
    expect(mockListCoupons).not.toHaveBeenCalled()
  })

  it("returns 401 when unauthenticated and 403 when the actor lacks VIEW_BILLING", async () => {
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Unauthorized", 401))
    expect((await GET_COUPONS(new NextRequest(url))).status).toBe(401)
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Forbidden", 403))
    const res = await GET_COUPONS(new NextRequest(url))
    expect(res.status).toBe(403)
    expect(mockListCoupons).not.toHaveBeenCalled()
  })

  it("returns the rate-limit response instead of the list", async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(
      new NextResponse(null, { status: 429 })
    )
    const res = await GET_COUPONS(new NextRequest(url))
    expect(res.status).toBe(429)
    expect(mockListCoupons).not.toHaveBeenCalled()
  })
})

describe("POST /api/v1/admin/coupons", () => {
  const url = "http://localhost:3001/api/v1/admin/coupons"

  it("creates and gates on MANAGE_BILLING (MANAGER may NOT create)", async () => {
    const res = await POST_COUPONS(
      postRequest(url, {
        code: "welcome10",
        discountType: "PERCENT",
        discountValue: 10,
      })
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      id: "cp-1",
      code: "WELCOME10",
      status: "ACTIVE",
    })
    expect(mockRequireAdminApi).toHaveBeenCalledWith("MANAGE_BILLING")
    expect(mockCreateCoupon).toHaveBeenCalledWith(
      mockSession,
      expect.objectContaining({
        code: "WELCOME10",
        discountType: "PERCENT",
        discountValue: 10,
        currency: "USD",
      })
    )
  })

  it("returns 422 for a percent over 100 without calling the service", async () => {
    const res = await POST_COUPONS(
      postRequest(url, {
        code: "BAD101",
        discountType: "PERCENT",
        discountValue: 101,
      })
    )
    expect(res.status).toBe(422)
    expect(mockCreateCoupon).not.toHaveBeenCalled()
  })

  it("returns 422 for a code with spaces without calling the service", async () => {
    const res = await POST_COUPONS(
      postRequest(url, {
        code: "BAD CODE",
        discountType: "PERCENT",
        discountValue: 10,
      })
    )
    expect(res.status).toBe(422)
    expect(mockCreateCoupon).not.toHaveBeenCalled()
  })

  it("returns 422 for a missing discount type without calling the service", async () => {
    const res = await POST_COUPONS(
      postRequest(url, { code: "NOPE01", discountValue: 10 })
    )
    expect(res.status).toBe(422)
    expect(mockCreateCoupon).not.toHaveBeenCalled()
  })

  it("returns 409 when the code already exists", async () => {
    mockCreateCoupon.mockRejectedValueOnce(
      new ApiError("A coupon with this code already exists.", 409)
    )
    const res = await POST_COUPONS(
      postRequest(url, {
        code: "WELCOME10",
        discountType: "PERCENT",
        discountValue: 10,
      })
    )
    expect(res.status).toBe(409)
  })

  it("returns 403 when the actor lacks MANAGE_BILLING", async () => {
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Forbidden", 403))
    const res = await POST_COUPONS(
      postRequest(url, {
        code: "WELCOME10",
        discountType: "PERCENT",
        discountValue: 10,
      })
    )
    expect(res.status).toBe(403)
    expect(mockCreateCoupon).not.toHaveBeenCalled()
  })
})

// ─── Routes: GET/PATCH/DELETE /api/v1/admin/coupons/[id] ──────────────

describe("GET /api/v1/admin/coupons/[id]", () => {
  const url = "http://localhost:3001/api/v1/admin/coupons/cp-1"

  it("returns the coupon and gates on VIEW_BILLING", async () => {
    const res = await GET_COUPON(new NextRequest(url), {
      params: Promise.resolve({ id: "cp-1" }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: "cp-1",
      code: "WELCOME10",
      status: "ACTIVE",
    })
    expect(mockRequireAdminApi).toHaveBeenCalledWith("VIEW_BILLING")
    expect(mockGetCoupon).toHaveBeenCalledWith(mockSession, "cp-1")
  })

  it("returns 403 when the actor lacks VIEW_BILLING", async () => {
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Forbidden", 403))
    const res = await GET_COUPON(new NextRequest(url), {
      params: Promise.resolve({ id: "cp-1" }),
    })
    expect(res.status).toBe(403)
    expect(mockGetCoupon).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/v1/admin/coupons/[id]", () => {
  const url = "http://localhost:3001/api/v1/admin/coupons/cp-1"

  it("disables with { status: DISABLED } and gates on MANAGE_BILLING", async () => {
    mockUpdateCoupon.mockResolvedValueOnce({
      id: "cp-1",
      code: "WELCOME10",
      status: "DISABLED",
    })
    const res = await PATCH_COUPON(patchRequest(url, { status: "DISABLED" }), {
      params: Promise.resolve({ id: "cp-1" }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: "cp-1",
      code: "WELCOME10",
      status: "DISABLED",
    })
    expect(mockRequireAdminApi).toHaveBeenCalledWith("MANAGE_BILLING")
    expect(mockUpdateCoupon).toHaveBeenCalledWith(mockSession, "cp-1", {
      status: "DISABLED",
    })
  })

  it("re-enables with { status: ACTIVE } (consolidation: updateCoupon exists)", async () => {
    const res = await PATCH_COUPON(patchRequest(url, { status: "ACTIVE" }), {
      params: Promise.resolve({ id: "cp-1" }),
    })
    expect(res.status).toBe(200)
    expect(mockUpdateCoupon).toHaveBeenCalledWith(mockSession, "cp-1", {
      status: "ACTIVE",
    })
  })

  it("edits a mutable field (name) with 200", async () => {
    const res = await PATCH_COUPON(patchRequest(url, { name: "Renamed" }), {
      params: Promise.resolve({ id: "cp-1" }),
    })
    expect(res.status).toBe(200)
    expect(mockUpdateCoupon).toHaveBeenCalledWith(mockSession, "cp-1", {
      name: "Renamed",
    })
  })

  it("accepts a mixed body (status + name) as one update", async () => {
    const res = await PATCH_COUPON(
      patchRequest(url, { status: "DISABLED", name: "Renamed" }),
      { params: Promise.resolve({ id: "cp-1" }) }
    )
    expect(res.status).toBe(200)
    expect(mockUpdateCoupon).toHaveBeenCalledWith(mockSession, "cp-1", {
      status: "DISABLED",
      name: "Renamed",
    })
  })

  it("refuses discountType changes with 422", async () => {
    const res = await PATCH_COUPON(
      patchRequest(url, { discountType: "FIXED" }),
      { params: Promise.resolve({ id: "cp-1" }) }
    )
    expect(res.status).toBe(422)
    expect(mockUpdateCoupon).not.toHaveBeenCalled()
  })

  it("refuses discountValue changes with 422", async () => {
    const res = await PATCH_COUPON(patchRequest(url, { discountValue: 50 }), {
      params: Promise.resolve({ id: "cp-1" }),
    })
    expect(res.status).toBe(422)
    expect(mockUpdateCoupon).not.toHaveBeenCalled()
  })

  it("refuses code changes with 422", async () => {
    const res = await PATCH_COUPON(patchRequest(url, { code: "NEWCODE" }), {
      params: Promise.resolve({ id: "cp-1" }),
    })
    expect(res.status).toBe(422)
    expect(mockUpdateCoupon).not.toHaveBeenCalled()
  })

  it("refuses an empty body with 422", async () => {
    const empty = await PATCH_COUPON(patchRequest(url, {}), {
      params: Promise.resolve({ id: "cp-1" }),
    })
    expect(empty.status).toBe(422)
    expect(mockUpdateCoupon).not.toHaveBeenCalled()
  })

  it("returns 403 when the actor lacks MANAGE_BILLING", async () => {
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Forbidden", 403))
    const res = await PATCH_COUPON(patchRequest(url, { status: "DISABLED" }), {
      params: Promise.resolve({ id: "cp-1" }),
    })
    expect(res.status).toBe(403)
    expect(mockUpdateCoupon).not.toHaveBeenCalled()
  })
})

describe("DELETE /api/v1/admin/coupons/[id]", () => {
  const url = "http://localhost:3001/api/v1/admin/coupons/cp-1"

  it("soft-deletes, returns 204 with an empty body, and gates on MANAGE_BILLING", async () => {
    const res = await DELETE_COUPON(
      new NextRequest(url, { method: "DELETE" }),
      {
        params: Promise.resolve({ id: "cp-1" }),
      }
    )
    expect(res.status).toBe(204)
    expect(await res.text()).toBe("")
    expect(mockRequireAdminApi).toHaveBeenCalledWith("MANAGE_BILLING")
    expect(mockDeleteCoupon).toHaveBeenCalledWith(mockSession, "cp-1")
  })

  it("returns 403 when the actor lacks MANAGE_BILLING", async () => {
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Forbidden", 403))
    const res = await DELETE_COUPON(
      new NextRequest(url, { method: "DELETE" }),
      {
        params: Promise.resolve({ id: "cp-1" }),
      }
    )
    expect(res.status).toBe(403)
    expect(mockDeleteCoupon).not.toHaveBeenCalled()
  })
})

// ─── Routes: GET /api/v1/admin/coupons/[id]/redemptions ───────────────

describe("GET /api/v1/admin/coupons/[id]/redemptions", () => {
  const url = "http://localhost:3001/api/v1/admin/coupons/cp-1/redemptions"

  it("returns the redemptions and gates on VIEW_BILLING", async () => {
    mockListCouponRedemptions.mockResolvedValueOnce({
      redemptions: [
        {
          id: "red-1",
          couponId: "cp-1",
          userId: "user-1",
          userName: "Customer One",
          userEmail: "one@example.com",
          subscriptionId: "sub-1",
          checkoutAttemptId: "att-1",
          discountAmount: 1000,
          currency: "USD",
          createdAt: new Date("2026-11-26T10:00:00Z"),
        },
      ],
      total: 1,
      page: 1,
      perPage: 20,
      totalPages: 1,
    })
    const res = await GET_REDEMPTIONS(new NextRequest(url), {
      params: Promise.resolve({ id: "cp-1" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(1)
    expect(body.redemptions[0].discountAmount).toBe(1000)
    expect(mockRequireAdminApi).toHaveBeenCalledWith("VIEW_BILLING")
    expect(mockListCouponRedemptions).toHaveBeenCalledWith(
      mockSession,
      "cp-1",
      {
        page: 1,
        perPage: 20,
      }
    )
  })

  it("returns 422 for a bad page without calling the service", async () => {
    const res = await GET_REDEMPTIONS(new NextRequest(`${url}?page=0`), {
      params: Promise.resolve({ id: "cp-1" }),
    })
    expect(res.status).toBe(422)
    expect(mockListCouponRedemptions).not.toHaveBeenCalled()
  })

  it("returns 403 when the actor lacks VIEW_BILLING", async () => {
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Forbidden", 403))
    const res = await GET_REDEMPTIONS(new NextRequest(url), {
      params: Promise.resolve({ id: "cp-1" }),
    })
    expect(res.status).toBe(403)
    expect(mockListCouponRedemptions).not.toHaveBeenCalled()
  })

  it("redemptions stay readable after a soft delete", async () => {
    // Delete (soft) first — 204, no body.
    const deleted = await DELETE_COUPON(
      new NextRequest("http://localhost:3001/api/v1/admin/coupons/cp-1", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "cp-1" }) }
    )
    expect(deleted.status).toBe(204)
    expect(await deleted.text()).toBe("")
    // The coupon itself reads DISABLED afterwards.
    mockGetCoupon.mockResolvedValueOnce({
      id: "cp-1",
      code: "WELCOME10",
      status: "DISABLED",
    })
    const after = await GET_COUPON(
      new NextRequest("http://localhost:3001/api/v1/admin/coupons/cp-1", {
        method: "GET",
      }),
      { params: Promise.resolve({ id: "cp-1" }) }
    )
    expect((await after.json()).status).toBe("DISABLED")
    // The redemption history is still listed afterwards.
    mockListCouponRedemptions.mockResolvedValueOnce({
      redemptions: [
        {
          id: "red-1",
          couponId: "cp-1",
          userId: "user-1",
          userName: null,
          userEmail: null,
          subscriptionId: null,
          checkoutAttemptId: null,
          discountAmount: 1000,
          currency: "USD",
          createdAt: new Date("2026-11-26T10:00:00Z"),
        },
      ],
      total: 1,
      page: 1,
      perPage: 20,
      totalPages: 1,
    })
    const res = await GET_REDEMPTIONS(new NextRequest(url), {
      params: Promise.resolve({ id: "cp-1" }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).total).toBe(1)
  })
})

// ─── Capability gate (Q10, plan §3.7) ──────────────────────────────────

describe("Coupons — capability gate (Q10, plan §3.7)", () => {
  it("is gated on VIEW_BILLING in PLATFORM_ROUTE_CAPABILITY", () => {
    expect(PLATFORM_ROUTE_CAPABILITY["/admin/coupons"]).toBe("VIEW_BILLING")
  })

  it("grants VIEW_BILLING to SUPER_ADMIN + MANAGER + owner, never SUPPORT", () => {
    for (const role of ["PLATFORM_OWNER", "SUPER_ADMIN", "MANAGER"] as const) {
      expect(adminCan(role, "VIEW_BILLING"), role).toBe(true)
    }
    expect(adminCan("SUPPORT", "VIEW_BILLING")).toBe(false)
    expect(adminCan("PLATFORM_USER", "VIEW_BILLING")).toBe(false)
  })

  it("grants MANAGE_BILLING to SUPER_ADMIN + owner only — MANAGER may NOT create", () => {
    expect(adminCan("PLATFORM_OWNER", "MANAGE_BILLING")).toBe(true)
    expect(adminCan("SUPER_ADMIN", "MANAGE_BILLING")).toBe(true)
    expect(adminCan("MANAGER", "MANAGE_BILLING")).toBe(false)
    expect(adminCan("SUPPORT", "MANAGE_BILLING")).toBe(false)
    expect(adminCan("PLATFORM_USER", "MANAGE_BILLING")).toBe(false)
  })
})

// ─── i18n ─────────────────────────────────────────────────────────────

describe("Coupons — i18n", () => {
  it("has the en + ur domain files with identical keys", () => {
    const en = JSON.parse(read("packages/i18n/locales/en/admin/coupons.json"))
    const ur = JSON.parse(read("packages/i18n/locales/ur/admin/coupons.json"))
    expect(Object.keys(en).sort()).toEqual(Object.keys(ur).sort())
    expect(en.title).toBe("Coupons")
    for (const key of [
      "description",
      "tabActive",
      "tabDisabled",
      "tabExpired",
      "statActive",
      "statRedemptions30d",
      "statDiscounted30d",
      "colCode",
      "colDiscount",
      "colRedemptions",
      "colStatus",
      "colValidUntil",
      "create",
      "createTitle",
      "createDescription",
      "createReview",
      "reviewTitle",
      "reviewDescription",
      "formCode",
      "formCodeHelp",
      "formDiscountType",
      "formDiscountValue",
      "formCurrency",
      "formMaxRedemptions",
      "formMaxPerUser",
      "formValidFrom",
      "formValidUntil",
      "formPlans",
      "formInterval",
      "formFirstPurchaseOnly",
      "detailTitle",
      "detailDiscount",
      "detailMaxRedemptions",
      "detailValidUntil",
      "redemptionsTitle",
      "redemptionsColAmount",
      "noCouponsTitle",
      "noRedemptionsTitle",
      "disableTitle",
      "disableDescription",
      "deleteTitle",
      "deleteDescription",
      "deleteNote",
      "showing",
      "pageOf",
      "previous",
      "next",
    ]) {
      expect(en[key], `en.${key}`).toBeDefined()
      expect(ur[key], `ur.${key}`).toBeDefined()
    }
    // Placeholders agree between locales (the validate script also
    // pins this; this is the page-level smoke check).
    expect(en.showing).toContain("{from}")
    expect(ur.showing).toContain("{from}")
    expect(en.statDiscounted30dDescription).toContain("{count}")
    expect(ur.statDiscounted30dDescription).toContain("{count}")
  })

  it("registers the domain in the i18n loader", () => {
    expect(read("packages/i18n/src/load.ts")).toContain('"coupons"')
  })

  it("uses the locale-aware format helpers — no new ones minted", () => {
    // Wave 7 helpers already have callers (plan-format.ts); this
    // page reuses them (formatAmountMinor / formatCurrency) instead
    // of minting new ones.
    expect(read("apps/admin/components/admin/plan-format.ts")).toContain(
      "formatCurrency"
    )
    expect(read("apps/admin/components/admin/plan-format.ts")).toContain(
      "formatAmountMinor"
    )
    expect(read("apps/admin/app/admin/coupons/page.tsx")).toContain(
      "formatCurrency"
    )
  })
})

// ─── Nav + page wiring ────────────────────────────────────────────────

describe("Coupons — nav + page wiring", () => {
  it("has the sidebar item `coupons` in Platform after `billing`", () => {
    const sidebar = read("apps/admin/components/admin/app-sidebar.tsx")
    expect(sidebar).toContain('href: "/admin/coupons"')
    expect(sidebar).toContain('t("coupons")')
    expect(sidebar.indexOf('href: "/admin/billing"')).toBeLessThan(
      sidebar.indexOf('href: "/admin/coupons"')
    )
    expect(sidebar.indexOf('href: "/admin/coupons"')).toBeLessThan(
      sidebar.indexOf('href: "/admin/payments"')
    )
  })

  it("pins the map entry in tests/permissions.test.ts", () => {
    expect(read("tests/permissions.test.ts")).toContain(
      '"/admin/coupons": "VIEW_BILLING"'
    )
  })

  it("adds loading.tsx + error.tsx for the new route (SRC-111 pattern)", () => {
    expect(
      existsSync(path.join(root, "apps/admin/app/admin/coupons/loading.tsx"))
    ).toBe(true)
    expect(
      existsSync(path.join(root, "apps/admin/app/admin/coupons/error.tsx"))
    ).toBe(true)
    expect(read("apps/admin/app/admin/coupons/loading.tsx")).toContain(
      "Skeleton"
    )
    const error = read("apps/admin/app/admin/coupons/error.tsx")
    expect(error).toContain('"use client"')
    expect(error).toContain("createLogger")
    // SEC-107: generic message, never the error's own message.
    expect(error).not.toContain("error.message")
  })

  it("puts the create action in the PageHeader slot only (UX-110)", () => {
    const page = read("apps/admin/app/admin/coupons/page.tsx")
    expect(page).toContain("CouponsCreateDialog")
    expect(page).toContain("PageHeader")
    // The table never renders the create dialog — one entry point.
    expect(read("apps/admin/components/admin/coupons-table.tsx")).not.toContain(
      "CouponsCreateDialog"
    )
  })

  it("renders the StatCard row + tabs + detail from the service, never the DB", () => {
    const page = read("apps/admin/app/admin/coupons/page.tsx")
    expect(page).toContain("StatCard")
    expect(page).toContain("listCoupons")
    expect(page).toContain("listCouponRedemptions")
    expect(page).not.toContain("@sendcms/database")
    expect(page).not.toContain("revalidatePath")
    const table = read("apps/admin/components/admin/coupons-table.tsx")
    expect(table).toContain("tabActive")
    expect(table).toContain("tabDisabled")
    expect(table).toContain("tabExpired")
    expect(table).not.toContain("apiFetch")
    expect(table).not.toContain("fetch(")
    expect(table).not.toContain("@sendcms/database")
  })
})

// ─── Routes stay thin ─────────────────────────────────────────────────

describe("Coupons — routes stay thin", () => {
  it("the collection routes gate, validate, and delegate — nothing else", () => {
    const list = read("apps/api/app/api/v1/admin/coupons/route.ts")
    expect(list).toContain('requireAdminApi("VIEW_BILLING")')
    expect(list).toContain('requireAdminApi("MANAGE_BILLING")')
    expect(list).toContain("CouponsQuerySchema")
    expect(list).toContain("CreateCouponSchema")
    expect(list).toContain("listCoupons")
    expect(list).toContain("createCoupon")
    expect(list).toContain("handleApiError")
    expect(list).not.toContain("@sendcms/database")
    expect(list).not.toContain("revalidatePath")
  })

  it("the detail route gates, updates, and soft-deletes — nothing else", () => {
    const detail = read("apps/api/app/api/v1/admin/coupons/[id]/route.ts")
    expect(detail).toContain('requireAdminApi("VIEW_BILLING")')
    expect(detail).toContain('requireAdminApi("MANAGE_BILLING")')
    expect(detail).toContain("getCoupon")
    expect(detail).toContain("updateCoupon")
    expect(detail).toContain("UpdateCouponSchema")
    expect(detail).toContain("deleteCoupon")
    expect(detail).toContain("noContent")
    expect(detail).toContain("handleApiError")
    expect(detail).not.toContain("@sendcms/database")
    expect(detail).not.toContain("revalidatePath")
  })

  it("the redemptions route gates, validates, and delegates — nothing else", () => {
    const redemptions = read(
      "apps/api/app/api/v1/admin/coupons/[id]/redemptions/route.ts"
    )
    expect(redemptions).toContain('requireAdminApi("VIEW_BILLING")')
    expect(redemptions).toContain("CouponRedemptionsQuerySchema")
    expect(redemptions).toContain("listCouponRedemptions")
    expect(redemptions).toContain("handleApiError")
    expect(redemptions).not.toContain("@sendcms/database")
    expect(redemptions).not.toContain("revalidatePath")
  })
})
