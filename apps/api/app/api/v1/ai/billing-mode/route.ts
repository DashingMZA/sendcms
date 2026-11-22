import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import {
  getUserAiBillingMode,
  setUserAiBillingMode,
} from "@sendcms/ai-settings"
import { SetBillingModeSchema } from "@sendcms/ai-settings/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// The customer's AI billing mode: BYOK (my keys), PLATFORM (the
// system's key), or DISABLED. BYOK pauses the platform key for this
// user until PLATFORM is re-enabled — no separate paused flag.
export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const billingMode = await getUserAiBillingMode(session.user.id)
    return ok({ billingMode })
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const body = await req.json().catch(() => ({}))
    const parsed = SetBillingModeSchema.safeParse(body)
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
    const billingMode = await setUserAiBillingMode(
      session.user.id,
      parsed.data.billingMode
    )
    return ok({ billingMode })
  } catch (err) {
    return handleApiError(err)
  }
}
