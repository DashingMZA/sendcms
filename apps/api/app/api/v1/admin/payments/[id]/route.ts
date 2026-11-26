import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getPaymentDetail } from "@sendcms/billing"
import { handleApiError, ok } from "@sendcms/api-client"

// Single-payment read (Seven Admin Pages, Phase B, plan §3.5) —
// none existed before this page. The id is a BillingEvent id or a
// OneTimePurchase id; anything else is a 404.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireAdminApi("VIEW_BILLING")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { id } = await params
    const detail = await getPaymentDetail(session, id)
    return ok(detail)
  } catch (err) {
    return handleApiError(err)
  }
}
