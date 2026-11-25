import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { createFlag, listFlags } from "@sendcms/platform-ops"
import { CreateFlagSchema } from "@sendcms/platform-ops/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Feature flags (DB-backed — NOT config/config.json). The Phase 4
// platform emergency flag in config.json stays the separate
// restart-gated kill-switch.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("MANAGE_FEATURE_FLAGS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const result = await listFlags(session)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApi("MANAGE_FEATURE_FLAGS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const body = await req.json().catch(() => ({}))
    const parsed = CreateFlagSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const flag = await createFlag(session, parsed.data, {
      correlationId: randomUUID(),
    })
    return ok(flag)
  } catch (err) {
    return handleApiError(err)
  }
}
