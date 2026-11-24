import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { reviewDeletionRequest } from "@sendcms/platform-ops"
import { ReviewDeletionRequestSchema } from "@sendcms/platform-ops/validators"
import { handleApiError, ok } from "@sendcms/api-client"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireAdminApi("MANAGE_USERS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = ReviewDeletionRequestSchema.safeParse(body)
    if (!parsed.success) {
      const flat = parsed.error.flatten()
      const messages = [
        ...flat.formErrors,
        ...Object.values(flat.fieldErrors).flat(),
      ].filter(Boolean)
      return NextResponse.json(
        { error: messages.join("; ") || "Validation failed" },
        { status: 422 }
      )
    }
    const request = await reviewDeletionRequest(session, id, parsed.data, {
      correlationId: randomUUID(),
    })
    return ok(request)
  } catch (err) {
    return handleApiError(err)
  }
}
