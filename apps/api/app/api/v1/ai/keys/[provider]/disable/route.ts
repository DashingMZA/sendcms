import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { disableUserAiKey } from "@sendcms/ai-settings"
import { AiProviderNameSchema } from "@sendcms/ai-settings/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

type Params = { params: Promise<{ provider: string }> }

export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const parsed = AiProviderNameSchema.safeParse((await params).provider)
    if (!parsed.success) throw new ApiError("Unknown provider.", 422)
    const key = await disableUserAiKey(session.user.id, parsed.data)
    return ok({ key })
  } catch (err) {
    return handleApiError(err)
  }
}
