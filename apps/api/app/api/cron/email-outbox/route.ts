import { NextRequest } from "next/server"
import { runEmailOutboxCron } from "@sendcms/cron"
import { isValidBearerToken } from "@sendcms/security"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Email outbox worker (Phase 9). Hit on a schedule by the platform
// cron (Vercel Cron / Cloudflare Cron Triggers) — see
// docs/email-notifications.md — or drained continuously by the
// standalone worker (`services/email-worker`). Auth is a shared secret:
// the scheduler sends `Authorization: Bearer <CRON_SECRET>`. Without
// CRON_SECRET set, the route refuses to run.
//
// One hit runs five jobs (Wave 9): the outbox drain, the AI spam
// re-scoring (Phase 12, Step 2), the AI digests (Phase 12, Step 3),
// subscription expiry (SRC-201), and missed-notification
// reconciliation (DB-032 / EML-043) — all in `@sendcms/cron`, each
// step isolated so one throwing step never cancels the others
// (EML-063). The response carries per-step counts + error fields.
//
// EML-062: `maxDuration = 60` (the Hobby max) with small per-step
// limits (outbox 25, as in the submit `after()` hook) — the 10 s
// default could not fit the workload.
export const maxDuration = 60

export async function GET(req: NextRequest) {
  try {
    requireCronSecret(req)
    return ok(await runEmailOutboxCron())
  } catch (err) {
    return handleApiError(err)
  }
}

// Cron auth: a shared secret, `Authorization: Bearer <CRON_SECRET>`.
// Without CRON_SECRET set, the route refuses to run.
function requireCronSecret(req: NextRequest): void {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    throw new ApiError("Email outbox cron is not configured.", 503)
  }
  // Timing-safe bearer check (SRC-115 / EML-067): the scheme is
  // case-insensitive and the token comparison is constant-time.
  if (!isValidBearerToken(req.headers.get("authorization"), secret)) {
    throw new ApiError("Unauthorized", 401)
  }
}
