import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { enforceCustomerAiRateLimit } from "@/lib/rate-limit"
import { testBrowserKey } from "@sendcms/ai-settings"
import {
  AiProviderNameSchema,
  TestBrowserKeySchema,
} from "@sendcms/ai-settings/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

type Params = { params: Promise<{ provider: string }> }

// The Test button for a browser-only key: the raw key travels in the
// request body for this one live call and is NEVER stored or logged.
// A failed test never falls back to the platform key.
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
    const parsedProvider = AiProviderNameSchema.safeParse(
      (await params).provider
    )
    if (!parsedProvider.success) throw new ApiError("Unknown provider.", 422)
    const body = await req.json().catch(() => null)
    const parsed = TestBrowserKeySchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(
        parsed.error.issues[0]?.message ?? "Invalid request.",
        422
      )
    }
    const result = await testBrowserKey(
      session.user.id,
      parsedProvider.data,
      parsed.data.apiKey,
      parsed.data.model,
      // AIM-001: a client disconnect aborts the probe instead of
      // letting it run out the 25 s timeout.
      { signal: req.signal }
    )
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
