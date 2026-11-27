import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { runManualEmailOutboxCron } from "@sendcms/cron"
import { handleApiError, ok } from "@sendcms/api-client"

// Manual cron run (Seven Admin Pages, Phase C, plan §3.6, Q9).
// MANAGE_JOBS + step-up re-auth. Step-up lives in the service
// (runManualEmailOutboxCron), checked last before the run — the
// requeue/refund pattern (Phase B) — so this route only gates,
// rate-limits, and delegates. Guards first, step-up last,
// single-use: one password entry authorizes exactly one manual run.
export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApi("MANAGE_JOBS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    return ok(await runManualEmailOutboxCron(session))
  } catch (err) {
    return handleApiError(err)
  }
}
