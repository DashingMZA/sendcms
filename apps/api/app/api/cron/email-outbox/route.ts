import { NextRequest } from "next/server"
import { processEmailOutbox } from "@sendcms/notifications"
import { isValidBearerToken } from "@sendcms/security"
import { rescoreNewSubmissions, sendDueDigests } from "@sendcms/submissions"
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
//
// Phase 12, Step 3: the same hit also sends due AI digests.
export async function GET(req: NextRequest) {
  try {
    const secret = process.env.CRON_SECRET
    if (!secret) {
      throw new ApiError("Email outbox cron is not configured.", 503)
    }
    const header = req.headers.get("authorization")
    // Timing-safe bearer check (SRC-115 / EML-067): the scheme is
    // case-insensitive and the token comparison is constant-time.
    if (!isValidBearerToken(header, secret)) {
      throw new ApiError("Unauthorized", 401)
    }
    // The three jobs are independent — run them concurrently
    // (SRC-115): serially, one hit ran three limit-100 jobs back to
    // back and grew toward serverless timeouts as the queues grew.
    const [result, rescore, digest] = await Promise.all([
      processEmailOutbox({ limit: 100 }),
      rescoreNewSubmissions({ limit: 100 }),
      sendDueDigests({ limit: 100 }),
    ])
    return ok({
      ...result,
      rescored: rescore.checked,
      markedSpam: rescore.markedSpam,
      digests: digest.sent,
    })
  } catch (err) {
    return handleApiError(err)
  }
}
