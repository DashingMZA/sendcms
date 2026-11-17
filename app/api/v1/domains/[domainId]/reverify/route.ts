import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { created } from "@/lib/api/response"
import { ApiError, handleApiError } from "@/lib/api/error"
import { startVerificationForUser } from "@/lib/services/domain-service"
import { ReverifyDomainSchema } from "@/lib/validators/domain"

type Params = { params: Promise<{ domainId: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { domainId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = ReverifyDomainSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "method must be DNS_TXT, META_TAG or FILE" },
        { status: 422 }
      )
    }
    const verification = await startVerificationForUser(
      session.user.id,
      domainId,
      parsed.data
    )
    revalidatePath("/dashboard", "layout")
    return created(verification)
  } catch (err) {
    return handleApiError(err)
  }
}
