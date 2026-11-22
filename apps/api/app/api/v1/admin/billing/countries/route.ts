import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listCountries } from "@sendcms/billing"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// The full country list from the DB table — the admin UI's
// multi-select options when setting up a provider.
export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    return ok(await listCountries(session))
  } catch (err) {
    return handleApiError(err)
  }
}
