import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { getSubscription } from "@sendcms/plans"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { subscriptionId } = await params
    const subscription = await getSubscription(session, subscriptionId)
    return ok(subscription)
  } catch (err) {
    return handleApiError(err)
  }
}
