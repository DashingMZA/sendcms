import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { addNotificationEmailToForm, getFormForUser } from "@sendcms/forms"
import { AddNotificationEmailSchema } from "@sendcms/forms/validators"
import { ApiError, created, handleApiError, ok } from "@sendcms/api-client"

type Params = { params: Promise<{ formId: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { formId } = await params
    const form = await getFormForUser(session.user.id, formId)
    return ok(form.notificationSettings)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { formId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = AddNotificationEmailSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Enter a valid email address" },
        { status: 422 }
      )
    }
    const row = await addNotificationEmailToForm(
      session.user.id,
      formId,
      parsed.data
    )
    revalidatePath("/dashboard", "layout")
    return created(row)
  } catch (err) {
    return handleApiError(err)
  }
}
