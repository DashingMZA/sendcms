import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { createApiKeyForUser, listApiKeysForUser } from "@sendcms/api-keys"
import { CreateApiKeySchema } from "@sendcms/api-keys/validators"
import { ApiError, created, handleApiError, ok } from "@sendcms/api-client"

export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const keys = await listApiKeysForUser(session.user.id)
    return ok(keys)
  } catch (err) {
    return handleApiError(err)
  }
}

// The created key's plaintext value is returned ONCE here — it is never
// stored and cannot be fetched again. The dashboard shows it once with
// a copy button, then it is gone.
export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const body = await req.json().catch(() => ({}))
    const parsed = CreateApiKeySchema.safeParse(body)
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
    const key = await createApiKeyForUser(session.user.id, parsed.data)
    revalidatePath("/dashboard", "layout")
    return created(key)
  } catch (err) {
    return handleApiError(err)
  }
}
