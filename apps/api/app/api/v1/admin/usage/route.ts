import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getUsage, startOfUtcMonth } from "@sendcms/plans"
import { UsageQuerySchema } from "@sendcms/plans/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
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
    const usage = await getUsage(parsed.data.userId, parsed.data.meter, period)
    return ok(usage)
  } catch (err) {
    return handleApiError(err)
  }
}
