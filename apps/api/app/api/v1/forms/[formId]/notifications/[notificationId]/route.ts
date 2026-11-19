import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import {
  deleteNotificationEmailForUser,
  updateNotificationEmailForUser,
} from "@sendcms/forms"
import { UpdateNotificationEmailSchema } from "@sendcms/forms/validators"
import { ApiError, handleApiError, noContent, ok } from "@sendcms/api-client"

type Params = {
  params: Promise<{ formId: string; notificationId: string }>
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { formId, notificationId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = UpdateNotificationEmailSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "enabled must be true or false" },
        { status: 422 }
      )
    }
    const row = await updateNotificationEmailForUser(
      session.user.id,
      formId,
      notificationId,
      parsed.data
    )
    revalidatePath("/dashboard", "layout")
    return ok(row)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { formId, notificationId } = await params
    await deleteNotificationEmailForUser(
      session.user.id,
      formId,
      notificationId
    )
    revalidatePath("/dashboard", "layout")
    return noContent()
  } catch (err) {
    return handleApiError(err)
  }
}
