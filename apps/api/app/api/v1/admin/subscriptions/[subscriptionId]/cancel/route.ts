import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { cancelSubscription } from "@sendcms/plans"
import { CancelSubscriptionSchema } from "@sendcms/plans/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { subscriptionId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = CancelSubscriptionSchema.safeParse(body)
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
    const subscription = await cancelSubscription(
      session,
      subscriptionId,
      parsed.data
    )
    return ok(subscription)
  } catch (err) {
    return handleApiError(err)
  }
}
