import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { removeEntitlementOverride } from "@sendcms/plans"
import { UsageMeterSchema } from "@sendcms/plans/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string; meter: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
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
