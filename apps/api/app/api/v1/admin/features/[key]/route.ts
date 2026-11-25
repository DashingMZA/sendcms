import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { deleteFlag, getFlag, setFlag } from "@sendcms/platform-ops"
import {
  DeleteFlagSchema,
  SetFlagSchema,
} from "@sendcms/platform-ops/validators"
import {
  handleApiError,
  noContent,
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
    const flag = await getFlag(session, key)
    return ok(flag)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  try {
    const session = await requireAdminApi("MANAGE_FEATURE_FLAGS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { key } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = SetFlagSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const flag = await setFlag(session, key, parsed.data, {
      correlationId: randomUUID(),
    })
    return ok(flag)
  } catch (err) {
    return handleApiError(err)
  }
}

// ADM-092: deletes the flag and its per-user overrides in one
// transaction. Reason required, audited; built-in system flags are
// refused with a 422 by the service. SRC-121: DELETE handlers return
// 204 noContent(), never a body — the service result is audited,
// not returned.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  try {
    const session = await requireAdminApi("MANAGE_FEATURE_FLAGS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { key } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = DeleteFlagSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    await deleteFlag(session, key, parsed.data, {
      correlationId: randomUUID(),
    })
    return noContent()
  } catch (err) {
    return handleApiError(err)
  }
}
