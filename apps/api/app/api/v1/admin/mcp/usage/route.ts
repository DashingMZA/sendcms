import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listMcpUsage } from "@sendcms/mcp-admin"
import { McpUsageListQuerySchema } from "@sendcms/mcp-admin/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Paginated MCP tool-call history, newest first. Counts only —
// request arguments and results are never recorded.
export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = McpUsageListQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
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
    const result = await listMcpUsage(session, parsed.data)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
