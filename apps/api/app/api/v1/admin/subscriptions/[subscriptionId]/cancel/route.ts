import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { cancelSubscriptionAtProvider } from "@sendcms/billing"
import { cancelSubscription } from "@sendcms/plans"
import { CancelSubscriptionSchema } from "@sendcms/plans/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// BIL-001 / BIL-082 (Wave 8): the admin cancel reaches the
// PROVIDER — a provider failure stops the cancel (502) instead of
// silently canceling only the SendCMS row while billing continues.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> }
) {
  try {
    const session = await requireAdminApi("MANAGE_SUBSCRIPTIONS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { subscriptionId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = CancelSubscriptionSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const subscription = await cancelSubscription(
      session,
      subscriptionId,
      parsed.data,
      { cancelAtProvider: cancelSubscriptionAtProvider }
    )
    return ok(subscription)
  } catch (err) {
    return handleApiError(err)
  }
}
