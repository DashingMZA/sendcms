import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { listEmailJobsForUser } from "@sendcms/notifications"
import { EmailJobListQuerySchema } from "@sendcms/notifications/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const parsed = EmailJobListQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      throw new ApiError("Invalid filters.", 400)
    }
    const result = await listEmailJobsForUser(session.user.id, parsed.data)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
