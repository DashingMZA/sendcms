import { NextRequest, NextResponse } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getMcpSettings, setMcpSettings } from "@sendcms/mcp-admin"
import { SetMcpSettingsSchema } from "@sendcms/mcp-admin/validators"
import { handleApiError, ok } from "@sendcms/api-client"

// The global MCP kill-switch. When globalEnabled is false, every MCP
// call is refused with 503 — form submission, the inbox, and every
// non-MCP service are untouched.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_MCP")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const settings = await getMcpSettings(session)
    return ok(settings)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApi("MANAGE_MCP")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const body = await req.json().catch(() => ({}))
    const parsed = SetMcpSettingsSchema.safeParse(body)
    if (!parsed.success) {
      const flat = parsed.error.flatten()
      const messages = [
        ...flat.formErrors,
        ...Object.values(flat.fieldErrors).flat(),
      ].filter(Boolean)
      return NextResponse.json(
        { error: messages.join("; ") || "Validation failed" },
        { status: 422 }
      )
    }
    const settings = await setMcpSettings(session, parsed.data)
    return ok(settings)
  } catch (err) {
    return handleApiError(err)
  }
}
