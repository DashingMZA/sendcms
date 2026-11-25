import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { assignSubscription } from "@sendcms/plans"
import { AssignSubscriptionSchema } from "@sendcms/plans/validators"
import {
  created,
  handleApiError,
  validationErrorResponse,
} from "@sendcms/api-client"

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApi("MANAGE_SUBSCRIPTIONS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const body = await req.json().catch(() => ({}))
    const parsed = AssignSubscriptionSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const subscription = await assignSubscription(session, parsed.data)
    return created(subscription)
  } catch (err) {
    return handleApiError(err)
  }
}
