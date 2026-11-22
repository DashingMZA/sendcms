import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { suggestFieldsForForm } from "@sendcms/forms"
import { AiProviderNameSchema } from "@sendcms/ai-settings/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// AI-assisted form building (Phase 12, Step 4). The owner describes
// the form; the model suggests fields. Returns suggestions only — the
// dashboard shows them for review, and fields are created through the
// normal fields endpoint when the owner picks them. An optional
// browser-only key (browserKey + browserProvider) is used for this
// call only and never stored.
type Params = { params: Promise<{ formId: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { formId } = await params
    const body = await req.json().catch(() => ({}))
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
    if (!prompt) {
      return NextResponse.json(
        { error: "A description is required." },
        { status: 422 }
      )
    }
    if (prompt.length > 1000) {
      return NextResponse.json(
        { error: "Description is too long." },
        { status: 422 }
      )
    }
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
    const suggestions = await suggestFieldsForForm(
      session.user.id,
      formId,
      prompt,
      process.env,
      {
        provider: browserProviderParsed.success
          ? browserProviderParsed.data
          : undefined,
        browserKey,
        browserModel,
      }
    )
    return ok(suggestions)
  } catch (err) {
    return handleApiError(err)
  }
}
