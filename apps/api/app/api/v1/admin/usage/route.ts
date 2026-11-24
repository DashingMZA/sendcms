import { NextRequest, NextResponse } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getUsage, startOfUtcMonth } from "@sendcms/plans"
import { UsageQuerySchema } from "@sendcms/plans/validators"
import { handleApiError, ok } from "@sendcms/api-client"

export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("MANAGE_USAGE")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = UsageQuerySchema.safeParse(
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
    const period = parsed.data.period
      ? new Date(`${parsed.data.period}T00:00:00.000Z`)
      : startOfUtcMonth()
    if (Number.isNaN(period.getTime())) {
      return NextResponse.json(
        { error: "Invalid period date" },
        { status: 422 }
      )
    }
    const usage = await getUsage(
      session,
      parsed.data.userId,
      parsed.data.meter,
      period
    )
    return ok(usage)
  } catch (err) {
    return handleApiError(err)
  }
}
