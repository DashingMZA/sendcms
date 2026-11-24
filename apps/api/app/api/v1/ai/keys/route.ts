import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { enforceCustomerAiRateLimit } from "@/lib/rate-limit"
import { listUserAiKeys, saveUserAiKey } from "@sendcms/ai-settings"
import { SaveAiKeySchema } from "@sendcms/ai-settings/validators"
import { ApiError, created, handleApiError, ok } from "@sendcms/api-client"

// The customer's own BYOK keys. List/save return metadata only —
// never the key or any ciphertext field.
export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const keys = await listUserAiKeys(session.user.id)
    return ok({ keys })
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const rateLimited = await enforceCustomerAiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const body = await req.json().catch(() => ({}))
    const parsed = SaveAiKeySchema.safeParse(body)
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
    const key = await saveUserAiKey(session.user.id, parsed.data)
    return created({ key })
  } catch (err) {
    return handleApiError(err)
  }
}
