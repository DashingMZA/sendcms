import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { getUserDetail } from "@sendcms/admin-users"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { userId } = await params
    const detail = await getUserDetail(session, userId)
    return ok(detail)
  } catch (err) {
    return handleApiError(err)
  }
}
