import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listUsers } from "@sendcms/admin-users"
import { AdminUserListQuerySchema } from "@sendcms/admin-users/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_USERS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = AdminUserListQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const users = await listUsers(session, parsed.data)
    return ok(users)
  } catch (err) {
    return handleApiError(err)
  }
}
