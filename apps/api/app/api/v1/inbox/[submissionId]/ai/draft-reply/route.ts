import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { pickAiEnvConfig } from "@sendcms/ai"
import { draftReplyForSubmission } from "@sendcms/inbox"
import { AiProviderNameSchema } from "@sendcms/ai-settings/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

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
    const browserKey =
      typeof body.browserKey === "string" && body.browserKey.trim()
        ? body.browserKey.trim()
        : undefined
    const browserProviderParsed = AiProviderNameSchema.safeParse(
      body.browserProvider
    )
    if (browserKey && !browserProviderParsed.success) {
      return NextResponse.json(
        { error: "A browser-only key needs its provider." },
        { status: 422 }
      )
    }
    if (browserKey && browserKey.length > 500) {
      return NextResponse.json(
        { error: "Browser key is too long." },
        { status: 422 }
      )
    }
    const browserModel =
      typeof body.browserModel === "string" && body.browserModel.trim()
        ? body.browserModel.trim()
        : undefined
    const draft = await draftReplyForSubmission(
      session.user.id,
      submissionId,
      // SRC-123: only the AI vars reach the service, never the
      // whole process.env.
      pickAiEnvConfig(process.env),
      {
        provider: browserProviderParsed.success
          ? browserProviderParsed.data
          : undefined,
        browserKey,
        browserModel,
      }
    )
    return ok(draft)
  } catch (err) {
    return handleApiError(err)
  }
}
