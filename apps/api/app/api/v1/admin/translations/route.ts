import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getTranslationCompletion } from "@sendcms/platform-ops"
import { handleApiError, ok } from "@sendcms/api-client"

// Per-locale, per-domain translation completion against `en`.
// Read-only: no endpoint here writes translation files.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("MANAGE_TRANSLATIONS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const result = await getTranslationCompletion(session)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
