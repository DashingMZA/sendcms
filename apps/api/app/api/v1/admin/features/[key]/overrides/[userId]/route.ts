import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { removeFlagOverride } from "@sendcms/platform-ops"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string; userId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { key, userId } = await params
    const result = await removeFlagOverride(session, key, userId, {
      correlationId: randomUUID(),
    })
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
