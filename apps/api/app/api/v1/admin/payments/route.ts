import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listPayments } from "@sendcms/billing"
import { PaymentsQuerySchema } from "@sendcms/billing/validators"
import {
  handleApiError,
  invalidDateFilterResponse,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Payments (Seven Admin Pages, Phase B, plan §3.5): the money view
// — every payment-kind BillingEvent once with an amount (or
// "unknown"), plus every OneTimePurchase once. Amounts come from the
// join in listPayments; BillingEvent stores none.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_BILLING")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = PaymentsQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const dateError = invalidDateFilterResponse({
      from: parsed.data.from,
      to: parsed.data.to,
    })
    if (dateError) return dateError
    const result = await listPayments(session, parsed.data)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
