import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listCheckoutAttempts } from "@sendcms/billing"
import { CheckoutAttemptsQuerySchema } from "@sendcms/billing/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Checkout attempts (BIL-028): one row per checkout creation —
// the support view of "I paid but nothing happened". Newest first,
// filterable by provider / user / status.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_BILLING")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = CheckoutAttemptsQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    return ok(await listCheckoutAttempts(session, parsed.data))
  } catch (err) {
    return handleApiError(err)
  }
}
