import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getUsage, startOfUtcMonth } from "@sendcms/plans"
import { UsageQuerySchema } from "@sendcms/plans/validators"
import {
  handleApiError,
  invalidDateFilterResponse,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("MANAGE_USAGE")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const query = Object.fromEntries(req.nextUrl.searchParams)
    const parsed = UsageQuerySchema.safeParse(query)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const period = resolveUsagePeriod(parsed.data.period)
    if (period instanceof Response) return period
    const usage = await getUsage(
      session,
      parsed.data.userId,
      parsed.data.meter,
      period
    )
    return ok(usage)
  } catch (err) {
    return handleApiError(err)
  }
}

// Resolves the `period` query param to a UTC-midnight Date, or the
// 422 response when the date is invalid. (SRC-119: `period` is
// validated here, with the same 422 shape as the schema failure
// above — the hand-rolled second 422 ("Invalid period date") is
// gone. The value is checked exactly as it is parsed, with the
// UTC-midnight suffix appended, so a string the check accepts can
// never produce an Invalid Date below.)
function resolveUsagePeriod(period?: string): Date | Response {
  const periodInput = period ? `${period}T00:00:00.000Z` : undefined
  const dateError = invalidDateFilterResponse({ period: periodInput }, [
    "period",
  ])
  if (dateError) return dateError
  return periodInput ? new Date(periodInput) : startOfUtcMonth()
}
