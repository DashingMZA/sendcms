import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getUserSubscription } from "@sendcms/plans"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const rateLimited = await enforceAdminApiRateLimit(_req, session.user.id)
    if (rateLimited) return rateLimited
    const { userId } = await params
    const subscription = await getUserSubscription(session, userId)
    return ok(subscription)
  } catch (err) {
    return handleApiError(err)
  }
}
