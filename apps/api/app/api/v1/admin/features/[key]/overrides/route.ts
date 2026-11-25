import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listFlagOverrides, setFlagOverride } from "@sendcms/platform-ops"
import { SetFlagOverrideBodySchema } from "@sendcms/platform-ops/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  try {
    const session = await requireAdminApi("MANAGE_FEATURE_FLAGS")
    const rateLimited = await enforceAdminApiRateLimit(_req, session.user.id)
    if (rateLimited) return rateLimited
    const { key } = await params
    const result = await listFlagOverrides(session, key)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  try {
    const session = await requireAdminApi("MANAGE_FEATURE_FLAGS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { key } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = SetFlagOverrideBodySchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const { userId, ...input } = parsed.data
    const override = await setFlagOverride(session, key, userId, input, {
      correlationId: randomUUID(),
    })
    return ok(override)
  } catch (err) {
    return handleApiError(err)
  }
}
