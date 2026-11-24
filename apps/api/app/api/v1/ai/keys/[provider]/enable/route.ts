import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { enforceCustomerAiRateLimit } from "@/lib/rate-limit"
import { enableUserAiKey } from "@sendcms/ai-settings"
import { AiProviderNameSchema } from "@sendcms/ai-settings/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

type Params = { params: Promise<{ provider: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const rateLimited = await enforceCustomerAiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = AiProviderNameSchema.safeParse((await params).provider)
    if (!parsed.success) throw new ApiError("Unknown provider.", 422)
    const key = await enableUserAiKey(session.user.id, parsed.data)
    return ok({ key })
  } catch (err) {
    return handleApiError(err)
  }
}
