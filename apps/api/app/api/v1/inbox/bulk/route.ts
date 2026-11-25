import { NextRequest } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { bulkUpdateSubmissionsForUser } from "@sendcms/inbox"
import { BulkUpdateSubmissionsSchema } from "@sendcms/inbox/validators"
import {
  ApiError,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const body = await req.json().catch(() => ({}))
    const parsed = BulkUpdateSubmissionsSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const result = await bulkUpdateSubmissionsForUser(
      session.user.id,
      parsed.data.ids,
      parsed.data.action
    )
    revalidatePath("/dashboard", "layout")
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
