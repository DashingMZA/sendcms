import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { getPlanVersion } from "@sendcms/plans"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ planId: string; versionId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { planId, versionId } = await params
    const version = await getPlanVersion(session, versionId)
    if (version.planId !== planId) {
      throw new ApiError("Plan version not found", 404)
    }
    return ok(version)
  } catch (err) {
    return handleApiError(err)
  }
}
