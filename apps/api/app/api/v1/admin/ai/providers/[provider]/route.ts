import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { setProviderConfig } from "@sendcms/ai-settings"
import {
  AiProviderNameSchema,
  UpdateProviderConfigSchema,
} from "@sendcms/ai-settings/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

type Params = { params: Promise<{ provider: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const providerParsed = AiProviderNameSchema.safeParse(
      (await params).provider
    )
    if (!providerParsed.success) throw new ApiError("Unknown provider.", 422)
    const body = await req.json().catch(() => ({}))
    const parsed = UpdateProviderConfigSchema.safeParse(body)
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
    const provider = await setProviderConfig(
      session,
      providerParsed.data,
      parsed.data
    )
    return ok({ provider })
  } catch (err) {
    return handleApiError(err)
  }
}
