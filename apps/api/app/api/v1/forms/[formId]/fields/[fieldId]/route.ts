import { NextRequest } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { deleteFieldForUser, updateFieldForUser } from "@sendcms/forms"
import { UpdateFieldSchema } from "@sendcms/forms/validators"
import {
  ApiError,
  handleApiError,
  noContent,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

type Params = { params: Promise<{ formId: string; fieldId: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { formId, fieldId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = UpdateFieldSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const field = await updateFieldForUser(
      session.user.id,
      formId,
      fieldId,
      parsed.data
    )
    revalidatePath("/dashboard", "layout")
    return ok(field)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { formId, fieldId } = await params
    await deleteFieldForUser(session.user.id, formId, fieldId)
    revalidatePath("/dashboard", "layout")
    return noContent()
  } catch (err) {
    return handleApiError(err)
  }
}
