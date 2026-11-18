import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { ok, noContent } from "@/lib/api/response"
import { ApiError, handleApiError } from "@/lib/api/error"
import {
  deleteFormForUser,
  getFormForUser,
  updateFormForUser,
} from "@sendcms/forms"
import { UpdateFormSchema } from "@sendcms/forms/validators"

type Params = { params: Promise<{ formId: string }> }

async function userIdOrThrow() {
  const session = await auth()
  if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
  return session.user.id
}

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const userId = await userIdOrThrow()
    const { formId } = await params
    const form = await getFormForUser(userId, formId)
    return ok(form)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const userId = await userIdOrThrow()
    const { formId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = UpdateFormSchema.safeParse(body)
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
    const form = await updateFormForUser(userId, formId, parsed.data)
    revalidatePath("/dashboard", "layout")
    return ok(form)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const userId = await userIdOrThrow()
    const { formId } = await params
    await deleteFormForUser(userId, formId)
    revalidatePath("/dashboard", "layout")
    return noContent()
  } catch (err) {
    return handleApiError(err)
  }
}
