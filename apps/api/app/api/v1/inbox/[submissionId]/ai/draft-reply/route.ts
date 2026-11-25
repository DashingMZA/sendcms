import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { pickAiEnvConfig } from "@sendcms/ai"
import { draftReplyForSubmission } from "@sendcms/inbox"
import { DraftReplySchema } from "@sendcms/inbox/validators"
import {
  ApiError,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Auto-reply drafts (Phase 12, Step 4). The model drafts a reply to
// one submission. Returns the draft only — nothing is sent. The
// dashboard shows it for review and editing; sending goes through
// the send-reply endpoint. An optional browser-only key (browserKey +
// browserProvider) is used for this call only and never stored.
type Params = { params: Promise<{ submissionId: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { submissionId } = await params
    const body = await req.json().catch(() => ({}))
    // SRC-104: the body is exactly the shared browser-only key trio
    // — no hand-rolled provider/key parsing in the route.
    const parsed = DraftReplySchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const draft = await draftReplyForSubmission(
      session.user.id,
      submissionId,
      // SRC-123: only the AI vars reach the service, never the
      // whole process.env.
      pickAiEnvConfig(process.env),
      {
        provider: parsed.data.browserProvider,
        browserKey: parsed.data.browserKey,
        browserModel: parsed.data.browserModel,
      }
    )
    return ok(draft)
  } catch (err) {
    return handleApiError(err)
  }
}
