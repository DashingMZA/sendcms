import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { CronRunsQuerySchema, listCronRuns } from "@sendcms/cron"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Admin cron-run list (Seven Admin Pages, Phase C, plan §3.6) —
// the Jobs page Cron runs section. VIEW_JOBS (all staff,
// Health-page parity). Calls Stream A's `listCronRuns` from
// `@sendcms/cron` (CronRun model + writer are Stream A).
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_JOBS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = CronRunsQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    return ok(await listCronRuns(session, parsed.data))
  } catch (err) {
    return handleApiError(err)
  }
}
