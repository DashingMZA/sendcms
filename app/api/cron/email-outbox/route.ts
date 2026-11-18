import { NextRequest } from "next/server"
import { processEmailOutbox } from "@sendcms/notifications"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"
import { notificationDeps } from "@/lib/email/notification-deps"

// Email outbox worker (Phase 8). Hit on a schedule by the platform
// cron (Vercel Cron / Cloudflare Cron Triggers) — see
// docs/email-notifications.md. Auth is a shared secret: the scheduler
// sends `Authorization: Bearer <CRON_SECRET>`. Without CRON_SECRET
// set, the route refuses to run.
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
    const result = await processEmailOutbox(notificationDeps, { limit: 100 })
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
