import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listUserAiKeysForAdmin } from "@sendcms/ai-settings"
import { handleApiError, ok } from "@sendcms/api-client"

type Params = { params: Promise<{ userId: string }> }

// An admin view of one user's keys — metadata only, never key
// material.
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const session = await requireAdminApi("MANAGE_AI")
    const rateLimited = await enforceAdminApiRateLimit(_req, session.user.id)
    if (rateLimited) return rateLimited
    const { userId } = await params
    const keys = await listUserAiKeysForAdmin(session, userId)
    return ok({ keys })
  } catch (err) {
    return handleApiError(err)
  }
}
