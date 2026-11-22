import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { executeErasure } from "@sendcms/platform-ops"
import { ExecuteErasureSchema } from "@sendcms/platform-ops/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Executes the erasure for an APPROVED request. The user row is
// anonymized (never deleted); billing/audit history survives.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = ExecuteErasureSchema.safeParse(body)
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
    const request = await executeErasure(session, id, parsed.data, {
      correlationId: randomUUID(),
    })
    return ok(request)
  } catch (err) {
    return handleApiError(err)
  }
}
