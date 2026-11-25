import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { enforceTestEmailRateLimit } from "@/lib/rate-limit"
import { sendTestSubmissionEmail } from "@sendcms/notifications"
import { TestEmailSchema } from "@sendcms/notifications/validators"
import {
  ApiError,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

type Params = { params: Promise<{ formId: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { formId } = await params
    // Email-sending route (EML-003): per-user + per-form buckets,
    // before any send is enqueued.
    const limited = await enforceTestEmailRateLimit(session.user.id, formId)
    if (limited) return limited
    const body = await req.json().catch(() => ({}))
    const parsed = TestEmailSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const result = await sendTestSubmissionEmail(
      session.user.id,
      formId,
      parsed.data.to
    )
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
