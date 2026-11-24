import { NextRequest, NextResponse } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listAuditLogs } from "@sendcms/platform-ops"
import { AuditLogsQuerySchema } from "@sendcms/platform-ops/validators"
import { handleApiError, ok } from "@sendcms/api-client"

// Append-only audit history, newest first. There is no update or
// delete endpoint for audit rows, by design.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_AUDIT_LOGS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = AuditLogsQuerySchema.safeParse(
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
    const result = await listAuditLogs(session, parsed.data)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
