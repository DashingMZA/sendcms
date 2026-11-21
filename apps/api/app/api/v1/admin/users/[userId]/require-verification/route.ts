import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { createAdminEmailSender } from "@/lib/admin-email-sender"
import { requireEmailVerification } from "@sendcms/admin-users"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { userId } = await params
    const updated = await requireEmailVerification(
      session,
      userId,
      createAdminEmailSender(req)
    )
    return ok(updated)
  } catch (err) {
    return handleApiError(err)
  }
}
