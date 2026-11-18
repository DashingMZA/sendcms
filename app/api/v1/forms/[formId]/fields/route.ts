import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { ok, created } from "@/lib/api/response"
import { ApiError, handleApiError } from "@/lib/api/error"
import { addFieldToForm, getFormForUser } from "@sendcms/forms"
import { CreateFieldSchema } from "@sendcms/forms/validators"

type Params = { params: Promise<{ formId: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { formId } = await params
    const form = await getFormForUser(session.user.id, formId)
    return ok(form.fields)
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
    const parsed = CreateFieldSchema.safeParse(body)
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
    const field = await addFieldToForm(session.user.id, formId, parsed.data)
    revalidatePath("/dashboard", "layout")
    return created(field)
  } catch (err) {
    return handleApiError(err)
  }
}
