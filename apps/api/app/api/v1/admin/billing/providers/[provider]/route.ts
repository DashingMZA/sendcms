import { NextRequest, NextResponse } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { setProviderConfig } from "@sendcms/billing"
import {
  setProviderConfigBodySchema,
  setProviderConfigSchema,
} from "@sendcms/billing/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

type Params = { params: Promise<{ provider: string }> }

// One provider's config: enable/disable + countries in a single
// PATCH body. Enabling requires the provider's env credentials.
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const session = await requireAdminApi("MANAGE_BILLING")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { provider } = await params
    // SRC-112: the provider name is parsed by the billing module's own
    // validator (the `provider` field of its body schema), not by
    // importing the Prisma enum value from the database package —
    // route handlers never import that package at runtime (layered
    // flow).
    const parsedProvider = setProviderConfigBodySchema.shape.provider.safeParse(
      provider.toUpperCase()
    )
    if (!parsedProvider.success) {
      return NextResponse.json(
        { error: `Unknown billing provider: ${provider}` },
        { status: 404 }
      )
    }
    const body = await req.json().catch(() => ({}))
    const parsed = setProviderConfigSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    return ok(
      await setProviderConfig(session, parsedProvider.data, parsed.data)
    )
  } catch (err) {
    return handleApiError(err)
  }
}
