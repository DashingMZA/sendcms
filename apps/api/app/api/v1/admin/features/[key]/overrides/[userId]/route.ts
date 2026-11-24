import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { removeFlagOverride } from "@sendcms/platform-ops"
import { handleApiError, ok } from "@sendcms/api-client"

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string; userId: string }> }
) {
  try {
    const session = await requireAdminApi("MANAGE_FEATURE_FLAGS")
    const rateLimited = await enforceAdminApiRateLimit(_req, session.user.id)
    if (rateLimited) return rateLimited
    const { key, userId } = await params
    const result = await removeFlagOverride(session, key, userId, {
      correlationId: randomUUID(),
    })
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
