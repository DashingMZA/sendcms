import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { setUserAiBillingModeForAdmin } from "@sendcms/ai-settings"
import { SetBillingModeSchema } from "@sendcms/ai-settings/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

type Params = { params: Promise<{ userId: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const session = await requireAdminApi("MANAGE_AI")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { userId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = SetBillingModeSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const billingMode = await setUserAiBillingModeForAdmin(
      session,
      userId,
      parsed.data.billingMode
    )
    return ok({ billingMode })
  } catch (err) {
    return handleApiError(err)
  }
}
