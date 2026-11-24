import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getUserSubscription } from "@sendcms/plans"
import { handleApiError, ok } from "@sendcms/api-client"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const session = await requireAdminApi("VIEW_CUSTOMER_DATA")
    const rateLimited = await enforceAdminApiRateLimit(_req, session.user.id)
    if (rateLimited) return rateLimited
    const { userId } = await params
    const subscription = await getUserSubscription(session, userId)
    return ok(subscription)
  } catch (err) {
    return handleApiError(err)
  }
}
