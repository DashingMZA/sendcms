import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { enforceCustomerAiRateLimit } from "@/lib/rate-limit"
import { testUserAiKey } from "@sendcms/ai-settings"
import { AiProviderNameSchema } from "@sendcms/ai-settings/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

type Params = { params: Promise<{ provider: string }> }

// The Test button: a minimal live call that proves the saved key
// works. A failed test never falls back to the platform key.
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const rateLimited = await enforceCustomerAiRateLimit(
      req,
      session.user.id,
      true
    )
    if (rateLimited) return rateLimited
    const parsed = AiProviderNameSchema.safeParse((await params).provider)
    if (!parsed.success) throw new ApiError("Unknown provider.", 422)
    const result = await testUserAiKey(session.user.id, parsed.data)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
