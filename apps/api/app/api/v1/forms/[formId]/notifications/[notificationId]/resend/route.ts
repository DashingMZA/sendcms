import { NextRequest } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { resendNotificationConfirmation } from "@sendcms/forms"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

type Params = {
  params: Promise<{ formId: string; notificationId: string }>
}

// Re-sends the confirmation email for an unconfirmed recipient
// (expired link, lost email). Only the form owner can do this.
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { formId, notificationId } = await params
    const row = await resendNotificationConfirmation(
      session.user.id,
      formId,
      notificationId
    )
    revalidatePath("/dashboard", "layout")
    return ok(row)
  } catch (err) {
    return handleApiError(err)
  }
}
