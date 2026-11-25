import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { cancelSubscription } from "@sendcms/plans"
import { CancelSubscriptionSchema } from "@sendcms/plans/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

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
      parsed.data
    )
    return ok(subscription)
  } catch (err) {
    return handleApiError(err)
  }
}
