import { auth } from "@/lib/auth"
import { getSystemSummary } from "@sendcms/platform-ops"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// The platform's own facts: runtime versions, env presence (never
// values), and the config.json emergency flag.
export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const summary = await getSystemSummary(session)
    return ok(summary)
  } catch (err) {
    return handleApiError(err)
  }
}
