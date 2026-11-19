import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { sendTestSubmissionEmail } from "@sendcms/notifications"
import { TestEmailSchema } from "@sendcms/notifications/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"
import { notificationDeps } from "@sendcms/email"

type Params = { params: Promise<{ formId: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { formId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = TestEmailSchema.safeParse(body)
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
    const result = await sendTestSubmissionEmail(
      notificationDeps,
      session.user.id,
      formId,
      parsed.data.to
    )
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
