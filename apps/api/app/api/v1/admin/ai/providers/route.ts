import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listProviderConfigs, setProviderConfig } from "@sendcms/ai-settings"
import { SetProviderConfigSchema } from "@sendcms/ai-settings/validators"
import { ApiError, created, handleApiError, ok } from "@sendcms/api-client"

// Admin provider config: all five providers with their enabled flag,
// model allowlist, and default model. Missing rows are auto-created
// with defaults on first read.
export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const providers = await listProviderConfigs(session)
    return ok({ providers })
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
    const parsed = SetProviderConfigSchema.safeParse(body)
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
    const { provider, ...config } = parsed.data
    const updated = await setProviderConfig(session, provider, config)
    return created({ provider: updated })
  } catch (err) {
    return handleApiError(err)
  }
}
