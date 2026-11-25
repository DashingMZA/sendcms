import { NextRequest } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import {
  createFormForUser,
  listFormsForUser,
  listFormsPageForUser,
} from "@sendcms/forms"
import {
  CreateFormSchema,
  FormListQuerySchema,
} from "@sendcms/forms/validators"
import {
  ApiError,
  created,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    // DSH-107: with no query params the bare array is returned (the
    // dashboard hooks' back-compat shape); any param switches to the
    // paged shape, and an unknown or invalid param 422s (strict
    // schema) instead of being silently dropped.
    const query = Object.fromEntries(req.nextUrl.searchParams)
    if (Object.keys(query).length === 0) {
      return ok(await listFormsForUser(session.user.id))
    }
    const parsed = FormListQuerySchema.safeParse(query)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    return ok(await listFormsPageForUser(session.user.id, parsed.data))
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
      return validationErrorResponse(parsed.error)
    }
    const form = await createFormForUser(session.user.id, parsed.data)
    revalidatePath("/dashboard", "layout")
    return created(form)
  } catch (err) {
    return handleApiError(err)
  }
}
