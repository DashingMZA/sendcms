import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { getPlatformSubmission } from "@sendcms/platform-ops"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// One submission WITH its `data`. The access is audit-logged by the
// service before the return.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ submissionId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { submissionId } = await params
    const submission = await getPlatformSubmission(session, submissionId, {
      correlationId: randomUUID(),
    })
    return ok(submission)
  } catch (err) {
    return handleApiError(err)
  }
}
