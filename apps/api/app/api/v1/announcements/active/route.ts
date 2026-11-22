import { auth } from "@/lib/auth"
import { listActiveAnnouncements } from "@sendcms/platform-ops"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// The announcements a signed-in caller may see right now. The
// audience comes from the actor, not the client: admins (owner or
// any staff role) see ALL + ADMIN_ONLY, customers see ALL only.
export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const includeAdminOnly =
      session.user.platformRole === "PLATFORM_OWNER" ||
      Boolean(session.user.adminRole)
    const result = await listActiveAnnouncements(includeAdminOnly)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
