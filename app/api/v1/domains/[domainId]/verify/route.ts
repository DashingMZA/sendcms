import { NextRequest } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { verifyDomainForUser } from "@sendcms/domains"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

type Params = { params: Promise<{ domainId: string }> }

export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { domainId } = await params
    const result = await verifyDomainForUser(session.user.id, domainId)
    if (result.verified) revalidatePath("/dashboard", "layout")
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
