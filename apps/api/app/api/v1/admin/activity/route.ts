import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listActivityFeed } from "@sendcms/platform-ops"
import { ActivityFeedQuerySchema } from "@sendcms/platform-ops/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Unified activity feed, newest first (Phase B, plan §3.1).
// Read-only: no mutation exists on this feed. Bad `from`/`to`
// dates are a 422 from the query schema, so the route needs no
// second date check.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_AUDIT_LOGS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = ActivityFeedQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const feed = await listActivityFeed(session, parsed.data)
    return ok(feed)
  } catch (err) {
    return handleApiError(err)
  }
}
