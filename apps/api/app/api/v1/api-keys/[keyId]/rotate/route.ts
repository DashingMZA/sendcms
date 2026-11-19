import { NextRequest } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { rotateApiKeyForUser } from "@sendcms/api-keys"
import { ApiError, created, handleApiError } from "@sendcms/api-client"

// Rotate issues a fresh key (same name + scope) and revokes the old one
// immediately. The new plaintext value is returned ONCE, like a create.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ keyId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { keyId } = await params
    const key = await rotateApiKeyForUser(session.user.id, keyId)
    revalidatePath("/dashboard", "layout")
    return created(key)
  } catch (err) {
    return handleApiError(err)
  }
}
