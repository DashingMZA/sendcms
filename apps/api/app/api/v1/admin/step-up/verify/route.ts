import { NextRequest, NextResponse } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { verifyStepUp } from "@sendcms/security"
import { requireAdmin } from "@sendcms/permissions"
import { handleApiError, ok } from "@sendcms/api-client"

// Step-up verification (Admin Control Plane, Phase 9): the admin
// re-enters their password before a high-impact action. The service
// checks the password against the credential Account row, counts
// the attempt against the 5/hour cap, and records a verification
// row valid for 10 minutes (config/config.json `stepUp`). The
// response carries only the expiry — never the password or the hash.
//
// SEC-105: the endpoint requires an admin capability — any
// authenticated user could otherwise mint verification rows, and
// the endpoint is part of the admin API like the rest of it.
// VIEW_ADMIN_DASHBOARD is the base admin capability every staff
// role holds; the per-action capability is enforced again by the
// action's own service call.
export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_ADMIN_DASHBOARD")
    requireAdmin(session, "VIEW_ADMIN_DASHBOARD")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const body = (await req.json().catch(() => ({}))) as unknown
    const password =
      typeof body === "object" &&
      body !== null &&
      "password" in body &&
      typeof (body as { password: unknown }).password === "string"
        ? (body as { password: string }).password
        : undefined
    if (password === undefined) {
      return NextResponse.json(
        { error: "Password is required." },
        { status: 422 }
      )
    }
    const result = await verifyStepUp(session, password)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
