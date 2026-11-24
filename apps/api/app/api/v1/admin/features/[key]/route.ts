import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getFlag, setFlag } from "@sendcms/platform-ops"
import { SetFlagSchema } from "@sendcms/platform-ops/validators"
import { handleApiError, ok } from "@sendcms/api-client"

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
    const flag = await setFlag(session, key, parsed.data, {
      correlationId: randomUUID(),
    })
    return ok(flag)
  } catch (err) {
    return handleApiError(err)
  }
}
