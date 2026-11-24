import { NextRequest, NextResponse } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getMcpUsageSummary } from "@sendcms/mcp-admin"
import { McpUsageSummaryQuerySchema } from "@sendcms/mcp-admin/validators"
import { handleApiError, ok } from "@sendcms/api-client"

// MCP usage totals: overall counts, per-tool counts, top users, and
// the last-24h error rate. Counts only.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_MCP")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = McpUsageSummaryQuerySchema.safeParse(
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
    const summary = await getMcpUsageSummary(session, parsed.data)
    return ok(summary)
  } catch (err) {
    return handleApiError(err)
  }
}
