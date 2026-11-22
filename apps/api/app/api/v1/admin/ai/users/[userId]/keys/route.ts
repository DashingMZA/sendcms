import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { listUserAiKeysForAdmin } from "@sendcms/ai-settings"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

type Params = { params: Promise<{ userId: string }> }

// An admin view of one user's keys — metadata only, never key
// material.
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { userId } = await params
    const keys = await listUserAiKeysForAdmin(session, userId)
    return ok({ keys })
  } catch (err) {
    return handleApiError(err)
  }
}
