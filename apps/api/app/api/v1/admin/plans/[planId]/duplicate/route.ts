import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { duplicatePlan } from "@sendcms/plans"
import { DuplicatePlanSchema } from "@sendcms/plans/validators"
import { ApiError, created, handleApiError } from "@sendcms/api-client"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ planId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { planId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = DuplicatePlanSchema.safeParse(body)
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
    const plan = await duplicatePlan(session, planId, parsed.data)
    return created(plan)
  } catch (err) {
    return handleApiError(err)
  }
}
