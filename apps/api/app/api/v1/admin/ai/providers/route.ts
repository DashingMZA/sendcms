import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listProviderConfigs, setProviderConfig } from "@sendcms/ai-settings"
import { SetProviderConfigSchema } from "@sendcms/ai-settings/validators"
import {
  created,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Admin provider config: all five providers with their enabled flag,
// model allowlist, and default model. Missing rows are auto-created
// with defaults on first read.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("MANAGE_AI")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const providers = await listProviderConfigs(session)
    return ok({ providers })
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApi("MANAGE_AI")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const body = await req.json().catch(() => ({}))
    const parsed = SetProviderConfigSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const { provider, ...config } = parsed.data
    const updated = await setProviderConfig(session, provider, config)
    return created({ provider: updated })
  } catch (err) {
    return handleApiError(err)
  }
}
