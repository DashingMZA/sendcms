import { NextRequest, NextResponse } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { revokeMcpKey } from "@sendcms/mcp-admin"
import { RevokeMcpKeySchema } from "@sendcms/mcp-admin/validators"
import { handleApiError, ok } from "@sendcms/api-client"

type Params = { params: Promise<{ keyId: string }> }

// Revokes one API key. The key stops working immediately; the
// revocation is audited with the reason.
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const session = await requireAdminApi("MANAGE_MCP")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { keyId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = RevokeMcpKeySchema.safeParse(body)
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
    const result = await revokeMcpKey(session, keyId, parsed.data.reason)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
