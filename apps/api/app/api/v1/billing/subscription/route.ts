import { auth } from "@/lib/auth"
import { getMySubscription } from "@sendcms/plans"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// The signed-in user's own active subscription (if any). Ownership
// is the check — a user only ever sees their own row.
export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    return ok(await getMySubscription(session.user.id))
  } catch (err) {
    return handleApiError(err)
  }
}
