import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { ok, noContent } from "@/lib/api/response"
import { ApiError, handleApiError } from "@/lib/api/error"
import {
  deleteDomainForUser,
  getDomainForUser,
  setDomainStatusForUser,
} from "@/lib/services/domain-service"
import { DomainActionSchema } from "@/lib/validators/domain"

type Params = { params: Promise<{ domainId: string }> }

async function userIdOrThrow() {
  const session = await auth()
  if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
  return session.user.id
}

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const userId = await userIdOrThrow()
    const { domainId } = await params
    const domain = await getDomainForUser(userId, domainId)
    return ok(domain)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const userId = await userIdOrThrow()
    const { domainId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = DomainActionSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "action must be suspend or reactivate" },
        { status: 422 }
      )
    }
    const domain = await setDomainStatusForUser(userId, domainId, parsed.data)
    revalidatePath("/dashboard", "layout")
    return ok(domain)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const userId = await userIdOrThrow()
    const { domainId } = await params
    await deleteDomainForUser(userId, domainId)
    revalidatePath("/dashboard", "layout")
    return noContent()
  } catch (err) {
    return handleApiError(err)
  }
}
