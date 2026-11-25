import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { enforceSendReplyRateLimit } from "@/lib/rate-limit"
import { sendReplyToSubmission } from "@sendcms/inbox"
import { SendReplySchema } from "@sendcms/inbox/validators"
import {
  ApiError,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Sends the owner's reply to a submission's sender through the
// outbox (Phase 12, Step 4). The body is the owner's own (reviewed
// and edited) words — the model is never involved in the send.
type Params = { params: Promise<{ submissionId: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { submissionId } = await params
    // Email-sending route (EML-003): per-user + per-submission
    // buckets, before any reply is enqueued.
    const limited = await enforceSendReplyRateLimit(
      session.user.id,
      submissionId
    )
    if (limited) return limited
    const body = await req.json().catch(() => ({}))
    // SRC-104: validated with Zod, not by hand — subject/body are
    // capped (200/2000, mirroring the service's limits), so no
    // unbounded string reaches the outbox.
    const parsed = SendReplySchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const result = await sendReplyToSubmission(session.user.id, submissionId, {
      subject: parsed.data.subject,
      body: parsed.data.body,
    })
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
