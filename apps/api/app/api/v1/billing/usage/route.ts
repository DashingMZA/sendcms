import { auth } from "@/lib/auth"
import { getMyUsage } from "@sendcms/plans"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// BIL-124 / AIM-014 (Wave 6): the signed-in customer's own plan,
// limits, and remaining quota per meter (forms, domains,
// submissions, API keys, MCP, AI). Owner-scoped by construction —
// the only input is the caller's userId. This MUST NOT reuse the
// admin usage route (SEC-101 — that one is admin-only); the numbers
// come from checkLimit, the same live counts enforcement uses.
export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    return ok(await getMyUsage(session.user.id))
  } catch (err) {
    return handleApiError(err)
  }
}
