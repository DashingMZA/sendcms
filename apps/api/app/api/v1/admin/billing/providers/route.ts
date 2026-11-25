import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listProviderConfigs, setProviderConfig } from "@sendcms/billing"
import { setProviderConfigBodySchema } from "@sendcms/billing/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Billing provider configs (admin): all five providers with their
// enabled state, env-configured state (booleans only, never values),
// and country mappings. POST sets one provider's config.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_BILLING")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    return ok(await listProviderConfigs(session))
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApi("MANAGE_BILLING")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const body = await req.json().catch(() => ({}))
    const parsed = setProviderConfigBodySchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const { provider, ...input } = parsed.data
    return ok(await setProviderConfig(session, provider, input))
  } catch (err) {
    return handleApiError(err)
  }
}
