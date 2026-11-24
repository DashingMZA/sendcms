import { NextRequest, NextResponse } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { removeEntitlementOverride } from "@sendcms/plans"
import { UsageMeterSchema } from "@sendcms/plans/validators"
import { handleApiError, ok } from "@sendcms/api-client"

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string; meter: string }> }
) {
  try {
    const session = await requireAdminApi("MANAGE_USAGE")
    const rateLimited = await enforceAdminApiRateLimit(_req, session.user.id)
    if (rateLimited) return rateLimited
    const { userId, meter } = await params
    const parsed = UsageMeterSchema.safeParse(meter)
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid meter" }, { status: 422 })
    }
    const result = await removeEntitlementOverride(session, userId, parsed.data)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
