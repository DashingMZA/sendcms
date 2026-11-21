import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { publishPlanVersion } from "@sendcms/plans"
import { PublishPlanVersionSchema } from "@sendcms/plans/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ planId: string; versionId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { planId, versionId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = PublishPlanVersionSchema.safeParse(body)
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
    const version = await publishPlanVersion(
      session,
      planId,
      versionId,
      parsed.data
    )
    return ok(version)
  } catch (err) {
    return handleApiError(err)
  }
}
