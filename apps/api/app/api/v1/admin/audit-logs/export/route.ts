import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { exportAuditLogs } from "@sendcms/platform-ops"
import { AuditLogsQuerySchema } from "@sendcms/platform-ops/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// The filtered audit rows as JSON, for download. The rows are
// returned as stored — safe only because services never write
// secrets into `detail`.
export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
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
    const result = await exportAuditLogs(session, parsed.data)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
