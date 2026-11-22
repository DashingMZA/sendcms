import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { createPlanVersion } from "@sendcms/plans"
import { CreatePlanVersionSchema } from "@sendcms/plans/validators"
import { ApiError, created, handleApiError } from "@sendcms/api-client"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ planId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { planId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = CreatePlanVersionSchema.safeParse(body)
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
    const version = await createPlanVersion(session, planId, parsed.data)
    return created(version)
  } catch (err) {
    return handleApiError(err)
  }
}
