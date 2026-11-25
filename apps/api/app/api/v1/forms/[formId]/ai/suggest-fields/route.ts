import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { pickAiEnvConfig } from "@sendcms/ai"
import { suggestFieldsForForm } from "@sendcms/forms"
import { SuggestFieldsSchema } from "@sendcms/forms/validators"
import {
  ApiError,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

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
    // SRC-104: validated with Zod, not by hand — the prompt is capped
    // at 1000 chars and the browser-only key trio is the shared
    // schema (a key without its provider 422s), so the two AI routes
    // no longer duplicate the parsing block.
    const parsed = SuggestFieldsSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const suggestions = await suggestFieldsForForm(
      session.user.id,
      formId,
      parsed.data.prompt,
      // SRC-123: only the AI vars reach the service, never the
      // whole process.env.
      pickAiEnvConfig(process.env),
      {
        provider: parsed.data.browserProvider,
        browserKey: parsed.data.browserKey,
        browserModel: parsed.data.browserModel,
      }
    )
    return ok(suggestions)
  } catch (err) {
    return handleApiError(err)
  }
}
