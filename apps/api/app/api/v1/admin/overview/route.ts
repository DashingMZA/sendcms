import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getAdminOverview } from "@sendcms/platform-ops"
import { OverviewQuerySchema } from "@sendcms/platform-ops/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Real platform overview for a date range. Reads need
// VIEW_ADMIN_DASHBOARD (enforced in the service).
export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const limited = await enforceAdminApiRateLimit(req, session.user.id)
    if (limited) return limited
    const parsed = OverviewQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      const flat = parsed.error.flatten()
      const messages = [
        ...flat.formErrors,
        ...Object.values(flat.fieldErrors).flat(),
      ].filter(Boolean)
      return NextResponse.json(
        { error: messages.join("; ") || "Validation failed" },
        { status: 422 }
      )
    }
    const overview = await getAdminOverview(session, parsed.data)
    return ok(overview)
  } catch (err) {
    return handleApiError(err)
  }
}
