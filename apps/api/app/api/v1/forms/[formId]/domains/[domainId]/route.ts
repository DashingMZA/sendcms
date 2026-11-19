import { NextRequest } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { unlinkDomainFromForm } from "@sendcms/forms"
import { ApiError, handleApiError, noContent } from "@sendcms/api-client"

type Params = { params: Promise<{ formId: string; domainId: string }> }

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { formId, domainId } = await params
    await unlinkDomainFromForm(session.user.id, formId, domainId)
    revalidatePath("/dashboard", "layout")
    return noContent()
  } catch (err) {
    return handleApiError(err)
  }
}
