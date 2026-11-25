import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getUserMcpSettings, setUserMcpSettings } from "@sendcms/mcp-admin"
import { SetUserMcpSettingsSchema } from "@sendcms/mcp-admin/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

type Params = { params: Promise<{ userId: string }> }

// One user's MCP controls: the enable switch, the tool allowlist
// (null = every tool the key's scope allows), and the per-user quota
// overrides (null = the plan's limits).
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const session = await requireAdminApi("VIEW_MCP")
    const rateLimited = await enforceAdminApiRateLimit(_req, session.user.id)
    if (rateLimited) return rateLimited
    const { userId } = await params
    const settings = await getUserMcpSettings(session, userId)
    return ok(settings)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const session = await requireAdminApi("MANAGE_MCP")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { userId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = SetUserMcpSettingsSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const settings = await setUserMcpSettings(session, userId, parsed.data)
    return ok(settings)
  } catch (err) {
    return handleApiError(err)
  }
}
