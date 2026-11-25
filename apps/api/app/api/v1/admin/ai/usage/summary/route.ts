import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getAiUsageSummary } from "@sendcms/ai-settings"
import { AiUsageSummaryQuerySchema } from "@sendcms/ai-settings/validators"
import {
  handleApiError,
  invalidDateFilterResponse,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

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
      return validationErrorResponse(parsed.error)
    }
    // SRC-231: a bad `from`/`to` is a 422, not a silently dropped
    // filter — the summary builder skips unparseable dates, so the
    // route rejects them before the service ever runs.
    const dateError = invalidDateFilterResponse({
      from: parsed.data.from,
      to: parsed.data.to,
    })
    if (dateError) return dateError
    const summary = await getAiUsageSummary(session, parsed.data)
    return ok(summary)
  } catch (err) {
    return handleApiError(err)
  }
}
