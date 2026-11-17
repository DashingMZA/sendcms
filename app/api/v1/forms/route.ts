import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { ok, created } from "@/lib/api/response"
import { ApiError, handleApiError } from "@/lib/api/error"
import {
  createFormForUser,
  listFormsForUser,
} from "@/lib/services/form-service"
import { CreateFormSchema } from "@/lib/validators/form"

export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const forms = await listFormsForUser(session.user.id)
    return ok(forms)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const body = await req.json().catch(() => ({}))
    const parsed = CreateFormSchema.safeParse(body)
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
    const form = await createFormForUser(session.user.id, parsed.data)
    revalidatePath("/dashboard", "layout")
    return created(form)
  } catch (err) {
    return handleApiError(err)
  }
}
