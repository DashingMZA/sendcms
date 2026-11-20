import { NextRequest } from "next/server"
import { processEmailOutbox } from "@sendcms/notifications"
import { rescoreNewSubmissions } from "@sendcms/submissions"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Email outbox worker (Phase 9). Hit on a schedule by the platform
// cron (Vercel Cron / Cloudflare Cron Triggers) — see
// docs/email-notifications.md — or drained continuously by the
// standalone worker (`services/email-worker`). Auth is a shared secret:
// the scheduler sends `Authorization: Bearer <CRON_SECRET>`. Without
// CRON_SECRET set, the route refuses to run.
//
// Phase 12, Step 2: the same hit also runs the AI spam re-scoring, so
// serverless deployments (no long-lived worker) still re-score. It is
// a no-op when no provider is configured or no form has AI on.
export async function GET(req: NextRequest) {
  try {
    const secret = process.env.CRON_SECRET
    if (!secret) {
      throw new ApiError("Email outbox cron is not configured.", 503)
    }
    const header = req.headers.get("authorization")
    if (header !== `Bearer ${secret}`) {
      throw new ApiError("Unauthorized", 401)
    }
    const result = await processEmailOutbox({ limit: 100 })
    const rescore = await rescoreNewSubmissions({ limit: 100 })
    return ok({
      ...result,
      rescored: rescore.checked,
      markedSpam: rescore.markedSpam,
    })
  } catch (err) {
    return handleApiError(err)
  }
}
