import { auth } from "@/lib/auth"
import { getMyAiUsage } from "@sendcms/ai-settings"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// AIM-014 (Wave 6): the signed-in customer's own AI usage — billing
// mode, remaining AI allowance for today, today's BYOK/platform
// calls, and provider-reported cost. Owner-scoped by construction —
// the only input is the caller's userId. This MUST NOT reuse the
// admin AI usage summary (SEC-101 — that one is admin-only).
export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    return ok(await getMyAiUsage(session.user.id))
  } catch (err) {
    return handleApiError(err)
  }
}
