import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { createCoupon, listCoupons } from "@sendcms/coupons"
import {
  CouponsQuerySchema,
  CreateCouponSchema,
} from "@sendcms/coupons/validators"
import {
  created,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Admin coupons list + create (Seven Admin Pages, Phase D, plan §3.7).
// View: VIEW_BILLING (SUPER_ADMIN + MANAGER + owner; SUPPORT excluded,
// same as /admin/billing). Create: MANAGE_BILLING (SUPER_ADMIN +
// owner only — Q10, MANAGER may NOT create). Duplicate code → 409
// from the service; validation → 422. No step-up for create
// (reversible); delete is a soft-disable, also no step-up.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_BILLING")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = CouponsQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    return ok(await listCoupons(session, parsed.data))
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApi("MANAGE_BILLING")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const body = await req.json().catch(() => ({}))
    const parsed = CreateCouponSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    return created(await createCoupon(session, parsed.data))
  } catch (err) {
    return handleApiError(err)
  }
}
