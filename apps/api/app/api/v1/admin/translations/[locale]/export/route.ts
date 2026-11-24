import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { exportTranslations } from "@sendcms/platform-ops"
import { handleApiError, ok } from "@sendcms/api-client"

// One locale's translation files as a single JSON bundle, for
// external review. Read-only.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ locale: string }> }
) {
  try {
    const session = await requireAdminApi("MANAGE_TRANSLATIONS")
    const rateLimited = await enforceAdminApiRateLimit(_req, session.user.id)
    if (rateLimited) return rateLimited
    const { locale } = await params
    const result = await exportTranslations(session, locale)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
