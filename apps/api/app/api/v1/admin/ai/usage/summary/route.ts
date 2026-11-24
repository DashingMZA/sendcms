import { NextRequest, NextResponse } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getAiUsageSummary } from "@sendcms/ai-settings"
import { AiUsageSummaryQuerySchema } from "@sendcms/ai-settings/validators"
import { handleApiError, ok } from "@sendcms/api-client"

// BYOK vs PLATFORM totals, separated — never mixed. Cost only counts
// provider-reported costs; it is never an estimate.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_AI_USAGE")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = AiUsageSummaryQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      const flat = parsed.error.flatten()
      const messages = [
        ...flat.formErrors,
        ...Object.values(flat.fieldErrors).flat(),
      ].filter(Boolean)
      return NextResponse.json(
        { error: messages.join("; ") || "Validation failed" },
        { status: 422 }
      )
    }
    const summary = await getAiUsageSummary(session, parsed.data)
    return ok(summary)
  } catch (err) {
    return handleApiError(err)
  }
}
