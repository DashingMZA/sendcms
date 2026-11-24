import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getUserSubmission } from "@sendcms/admin-users"
import { handleApiError, ok } from "@sendcms/api-client"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string; submissionId: string }> }
) {
  try {
    const session = await requireAdminApi("VIEW_SENSITIVE_SUBMISSIONS")
    const rateLimited = await enforceAdminApiRateLimit(_req, session.user.id)
    if (rateLimited) return rateLimited
    const { userId, submissionId } = await params
    const submission = await getUserSubmission(session, userId, submissionId)
    return ok(submission)
  } catch (err) {
    return handleApiError(err)
  }
}
