import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { updatePlatformSubmissionStatus } from "@sendcms/platform-ops"
import { UpdatePlatformSubmissionStatusSchema } from "@sendcms/platform-ops/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ submissionId: string }> }
) {
  try {
    const session = await requireAdminApi("MANAGE_USERS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { submissionId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = UpdatePlatformSubmissionStatusSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const result = await updatePlatformSubmissionStatus(
      session,
      submissionId,
      parsed.data,
      { correlationId: randomUUID() }
    )
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
