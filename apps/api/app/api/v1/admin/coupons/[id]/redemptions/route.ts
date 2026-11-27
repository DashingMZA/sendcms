import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listCouponRedemptions } from "@sendcms/coupons"
import { CouponRedemptionsQuerySchema } from "@sendcms/coupons/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

type Params = { params: Promise<{ id: string }> }

// One coupon's redemptions, newest first (Seven Admin Pages,
// Phase D, plan §3.7). VIEW_BILLING — the redemption history is
// part of the coupon detail; a soft-deleted (DISABLED) coupon still
// shows its redemptions.
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const session = await requireAdminApi("VIEW_BILLING")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { id } = await params
    const parsed = CouponRedemptionsQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    return ok(await listCouponRedemptions(session, id, parsed.data))
  } catch (err) {
    return handleApiError(err)
  }
}
