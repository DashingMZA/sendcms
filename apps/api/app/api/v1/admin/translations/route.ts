import { auth } from "@/lib/auth"
import { getTranslationCompletion } from "@sendcms/platform-ops"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Per-locale, per-domain translation completion against `en`.
// Read-only: no endpoint here writes translation files.
export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const result = await getTranslationCompletion(session)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
