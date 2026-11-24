import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getPlatformSubmission } from "@sendcms/platform-ops"
import { handleApiError, ok } from "@sendcms/api-client"

// One submission WITH its `data`. The access is audit-logged by the
// service before the return.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ submissionId: string }> }
) {
  try {
    const session = await requireAdminApi("VIEW_SENSITIVE_SUBMISSIONS")
    const rateLimited = await enforceAdminApiRateLimit(_req, session.user.id)
    if (rateLimited) return rateLimited
    const { submissionId } = await params
    const submission = await getPlatformSubmission(session, submissionId, {
      correlationId: randomUUID(),
    })
    return ok(submission)
  } catch (err) {
    return handleApiError(err)
  }
}
