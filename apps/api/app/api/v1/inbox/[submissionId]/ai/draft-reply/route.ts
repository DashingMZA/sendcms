import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { draftReplyForSubmission } from "@sendcms/inbox"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Auto-reply drafts (Phase 12, Step 4). The model drafts a reply to
// one submission. Returns the draft only — nothing is sent. The
// dashboard shows it for review and editing; sending goes through
// the send-reply endpoint.
type Params = { params: Promise<{ submissionId: string }> }

export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { submissionId } = await params
    const draft = await draftReplyForSubmission(session.user.id, submissionId)
    return ok(draft)
  } catch (err) {
    return handleApiError(err)
  }
}
