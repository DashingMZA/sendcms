import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { enforceSendReplyRateLimit } from "@/lib/rate-limit"
import { sendReplyToSubmission } from "@sendcms/inbox"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

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
    const subject = typeof body.subject === "string" ? body.subject : ""
    const replyBody = typeof body.body === "string" ? body.body : ""
    if (!subject.trim() || !replyBody.trim()) {
      return NextResponse.json(
        { error: "Subject and body are both required." },
        { status: 422 }
      )
    }
    const result = await sendReplyToSubmission(session.user.id, submissionId, {
      subject,
      body: replyBody,
    })
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
