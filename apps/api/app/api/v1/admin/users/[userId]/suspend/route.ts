import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { suspendUser } from "@sendcms/admin-users"
import { SuspendUserSchema } from "@sendcms/admin-users/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const session = await requireAdminApi("MANAGE_USERS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { userId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = SuspendUserSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const updated = await suspendUser(session, userId, parsed.data)
    return ok(updated)
  } catch (err) {
    return handleApiError(err)
  }
}
