import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listUserSubmissions } from "@sendcms/admin-users"
import { AdminUserSubmissionsQuerySchema } from "@sendcms/admin-users/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const session = await requireAdminApi("VIEW_CUSTOMER_DATA")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { userId } = await params
    const parsed = AdminUserSubmissionsQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const submissions = await listUserSubmissions(session, userId, parsed.data)
    return ok(submissions)
  } catch (err) {
    return handleApiError(err)
  }
}
