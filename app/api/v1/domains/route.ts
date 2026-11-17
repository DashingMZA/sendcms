import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { ok, created } from "@/lib/api/response"
import { ApiError, handleApiError } from "@/lib/api/error"
import {
  createDomainForUser,
  listDomainsForUser,
} from "@/lib/services/domain-service"
import { CreateDomainSchema } from "@/lib/validators/domain"

export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const domains = await listDomainsForUser(session.user.id)
    return ok(domains)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const body = await req.json().catch(() => ({}))
    const parsed = CreateDomainSchema.safeParse(body)
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
    const domain = await createDomainForUser(session.user.id, parsed.data)
    revalidatePath("/dashboard", "layout")
    return created(domain)
  } catch (err) {
    return handleApiError(err)
  }
}
