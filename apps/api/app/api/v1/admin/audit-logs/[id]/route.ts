import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { getAuditLog } from "@sendcms/platform-ops"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { id } = await params
    const log = await getAuditLog(session, id)
    return ok(log)
  } catch (err) {
    return handleApiError(err)
  }
}
