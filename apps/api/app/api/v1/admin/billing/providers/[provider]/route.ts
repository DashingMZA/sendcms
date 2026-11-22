import { NextRequest, NextResponse } from "next/server"
import { BillingProvider } from "@sendcms/database"
import { auth } from "@/lib/auth"
import { setProviderConfig } from "@sendcms/billing"
import { setProviderConfigSchema } from "@sendcms/billing/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

type Params = { params: Promise<{ provider: string }> }

// One provider's config: enable/disable + countries in a single
// PATCH body. Enabling requires the provider's env credentials.
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { provider } = await params
    const parsedProvider =
      BillingProvider[provider.toUpperCase() as keyof typeof BillingProvider]
    if (!parsedProvider) {
      return NextResponse.json(
        { error: `Unknown billing provider: ${provider}` },
        { status: 404 }
      )
    }
    const body = await req.json().catch(() => ({}))
    const parsed = setProviderConfigSchema.safeParse(body)
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
    return ok(await setProviderConfig(session, parsedProvider, parsed.data))
  } catch (err) {
    return handleApiError(err)
  }
}
