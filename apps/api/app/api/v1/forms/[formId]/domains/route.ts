import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { getFormForUser, linkDomainToForm } from "@sendcms/forms"
import { LinkDomainSchema } from "@sendcms/forms/validators"
import { ApiError, created, handleApiError, ok } from "@sendcms/api-client"

type Params = { params: Promise<{ formId: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { formId } = await params
    const form = await getFormForUser(session.user.id, formId)
    return ok(form.domainLinks)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { formId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = LinkDomainSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Choose a domain to link" },
        { status: 422 }
      )
    }
    const link = await linkDomainToForm(session.user.id, formId, parsed.data)
    revalidatePath("/dashboard", "layout")
    return created(link)
  } catch (err) {
    return handleApiError(err)
  }
}
