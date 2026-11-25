import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getMigrationPreview } from "@sendcms/plans"
import { MigrationPreviewSchema } from "@sendcms/plans/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApi("MIGRATE_SUBSCRIPTIONS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const body = await req.json().catch(() => ({}))
    const parsed = MigrationPreviewSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const preview = await getMigrationPreview(session, parsed.data)
    return ok(preview)
  } catch (err) {
    return handleApiError(err)
  }
}
