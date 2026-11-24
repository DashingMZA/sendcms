import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getProviderHealth } from "@sendcms/ai-settings"
import { handleApiError, ok } from "@sendcms/api-client"

// Per-provider health: admin config, whether the platform key is
// set, and the last-24h error rate from usage records — counts only,
// no key material.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("MANAGE_AI")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const providers = await getProviderHealth(session)
    return ok({ providers })
  } catch (err) {
    return handleApiError(err)
  }
}
