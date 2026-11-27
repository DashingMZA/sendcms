import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { deleteCoupon, getCoupon, updateCoupon } from "@sendcms/coupons"
import { UpdateCouponSchema } from "@sendcms/coupons/validators"
import {
  handleApiError,
  noContent,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

type Params = { params: Promise<{ id: string }> }

// One coupon: read (VIEW_BILLING), update (MANAGE_BILLING),
// soft-delete (MANAGE_BILLING). PATCH accepts the mutable fields
// only (name, description, caps, window, plan scoping, status
// ACTIVE ↔ DISABLED) — code / discountType / discountValue /
// currency are rejected with 422 by the schema; the deal itself is
// immutable once issued. DELETE is a soft delete (status →
// DISABLED) and returns 204 with an empty body (SRC-121); the
// coupon is re-read with GET afterwards. Redemption history
// survives either way.
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const session = await requireAdminApi("VIEW_BILLING")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { id } = await params
    return ok(await getCoupon(session, id))
  } catch (err) {
    return handleApiError(err)
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const session = await requireAdminApi("MANAGE_BILLING")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = UpdateCouponSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    return ok(await updateCoupon(session, id, parsed.data))
  } catch (err) {
    return handleApiError(err)
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const session = await requireAdminApi("MANAGE_BILLING")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { id } = await params
    await deleteCoupon(session, id)
    return noContent()
  } catch (err) {
    return handleApiError(err)
  }
}
