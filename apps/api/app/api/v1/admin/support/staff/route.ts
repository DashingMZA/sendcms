import { auth } from "@/lib/auth"
import { listStaffUsers } from "@sendcms/support"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Staff users (owner + admin-role holders), for the ticket assign
// picker. Reads need MANAGE_USERS or the SUPPORT role (enforced in
// the service).
export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const result = await listStaffUsers(session)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
