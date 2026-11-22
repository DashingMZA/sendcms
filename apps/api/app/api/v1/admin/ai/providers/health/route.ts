import { auth } from "@/lib/auth"
import { getProviderHealth } from "@sendcms/ai-settings"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Per-provider health: admin config, whether the platform key is
// set, and the last-24h error rate from usage records — counts only,
// no key material.
export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const providers = await getProviderHealth(session)
    return ok({ providers })
  } catch (err) {
    return handleApiError(err)
  }
}
