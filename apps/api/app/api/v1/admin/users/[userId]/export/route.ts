import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { exportUserData } from "@sendcms/admin-users"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { userId } = await params
    const data = await exportUserData(session, userId)
    return ok(data)
  } catch (err) {
    return handleApiError(err)
  }
}
