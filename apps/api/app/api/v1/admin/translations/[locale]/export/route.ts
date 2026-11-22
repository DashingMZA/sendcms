import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { exportTranslations } from "@sendcms/platform-ops"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// One locale's translation files as a single JSON bundle, for
// external review. Read-only.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ locale: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { locale } = await params
    const result = await exportTranslations(session, locale)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
