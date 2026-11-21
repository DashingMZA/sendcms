import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { suspendUser } from "@sendcms/admin-users"
import { SuspendUserSchema } from "@sendcms/admin-users/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { userId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = SuspendUserSchema.safeParse(body)
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
    const updated = await suspendUser(session, userId, parsed.data)
    return ok(updated)
  } catch (err) {
    return handleApiError(err)
  }
}
