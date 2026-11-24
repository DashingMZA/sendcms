import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listCountries } from "@sendcms/billing"
import { handleApiError, ok } from "@sendcms/api-client"

// The full country list from the DB table — the admin UI's
// multi-select options when setting up a provider.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_BILLING")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    return ok(await listCountries(session))
  } catch (err) {
    return handleApiError(err)
  }
}
