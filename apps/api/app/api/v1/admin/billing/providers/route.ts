import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listProviderConfigs, setProviderConfig } from "@sendcms/billing"
import { setProviderConfigBodySchema } from "@sendcms/billing/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Billing provider configs (admin): all five providers with their
// enabled state, env-configured state (booleans only, never values),
// and country mappings. POST sets one provider's config.
export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    return ok(await listProviderConfigs(session))
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const body = await req.json().catch(() => ({}))
    const parsed = setProviderConfigBodySchema.safeParse(body)
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
    const { provider, ...input } = parsed.data
    return ok(await setProviderConfig(session, provider, input))
  } catch (err) {
    return handleApiError(err)
  }
}
