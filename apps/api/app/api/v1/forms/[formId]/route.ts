import { NextRequest } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import {
  deleteFormForUser,
  getFormForUser,
  updateFormForUser,
} from "@sendcms/forms"
import { UpdateFormSchema } from "@sendcms/forms/validators"
import { isTurnstileConfigured } from "@sendcms/submissions/turnstile"
import {
  ApiError,
  handleApiError,
  noContent,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

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
    // SDK-016: the dashboard process cannot know the API server's
    // secret, so the flag rides with the detail — the form page warns
    // when Turnstile is on but the server cannot verify tokens.
    return ok({ ...form, turnstileConfigured: isTurnstileConfigured() })
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
      return validationErrorResponse(parsed.error)
    }
    const form = await updateFormForUser(userId, formId, parsed.data)
    revalidatePath("/dashboard", "layout")
    return ok(form)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const userId = await userIdOrThrow()
    const { formId } = await params
    const body = await req.json().catch(() => ({}))
    const confirmation =
      typeof (body as { confirmation?: unknown }).confirmation === "string"
        ? (body as { confirmation: string }).confirmation
        : ""
    await deleteFormForUser(userId, formId, confirmation)
    revalidatePath("/dashboard", "layout")
    return noContent()
  } catch (err) {
    return handleApiError(err)
  }
}
