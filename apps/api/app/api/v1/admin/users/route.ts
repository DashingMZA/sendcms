import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { listUsers } from "@sendcms/admin-users"
import { AdminUserListQuerySchema } from "@sendcms/admin-users/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const parsed = AdminUserListQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
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
    const users = await listUsers(session, parsed.data)
    return ok(users)
  } catch (err) {
    return handleApiError(err)
  }
}
