import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { ok, noContent } from "@/lib/api/response"
import { ApiError, handleApiError } from "@/lib/api/error"
import {
  deleteSubmissionForUser,
  getSubmissionForUser,
  updateSubmissionStatusForUser,
} from "@sendcms/inbox"
import { UpdateSubmissionStatusSchema } from "@sendcms/inbox/validators"

type Params = { params: Promise<{ submissionId: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { submissionId } = await params
    const submission = await getSubmissionForUser(session.user.id, submissionId)
    return ok(submission)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { submissionId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = UpdateSubmissionStatusSchema.safeParse(body)
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
    const result = await updateSubmissionStatusForUser(
      session.user.id,
      submissionId,
      parsed.data.action
    )
    revalidatePath("/dashboard", "layout")
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { submissionId } = await params
    await deleteSubmissionForUser(session.user.id, submissionId)
    revalidatePath("/dashboard", "layout")
    return noContent()
  } catch (err) {
    return handleApiError(err)
  }
}
