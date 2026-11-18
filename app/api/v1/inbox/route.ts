import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { listSubmissionsForUser } from "@sendcms/inbox"
import { InboxListQuerySchema } from "@sendcms/inbox/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const parsed = InboxListQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    // Invalid filter values fall back to defaults (the schema's
    // .catch()s), so this only fails on a structurally broken query.
    if (!parsed.success) {
      throw new ApiError("Invalid filters.", 400)
    }
    const result = await listSubmissionsForUser(session.user.id, parsed.data)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
