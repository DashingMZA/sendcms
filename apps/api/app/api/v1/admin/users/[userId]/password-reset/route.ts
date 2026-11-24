import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { createAdminEmailSender } from "@/lib/admin-email-sender"
import { triggerPasswordReset } from "@sendcms/admin-users"
import { handleApiError, ok } from "@sendcms/api-client"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const session = await requireAdminApi("MANAGE_USERS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { userId } = await params
    const result = await triggerPasswordReset(
      session,
      userId,
      createAdminEmailSender(req)
    )
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
