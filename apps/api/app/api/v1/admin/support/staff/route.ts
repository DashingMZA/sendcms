import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listStaffUsers } from "@sendcms/support"
import { handleApiError, ok } from "@sendcms/api-client"

// Staff users (owner + admin-role holders), for the ticket assign
// picker. Reads need MANAGE_USERS or the SUPPORT role (enforced in
// the service).
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_CUSTOMER_DATA")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const result = await listStaffUsers(session)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
