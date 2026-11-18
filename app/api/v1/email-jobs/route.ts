import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { ok } from "@/lib/api/response"
import { ApiError, handleApiError } from "@/lib/api/error"
import { listEmailJobsForUser } from "@/lib/services/email-outbox"
import { EmailJobListQuerySchema } from "@/lib/validators/email-jobs"

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
