import { NextRequest } from "next/server"
import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import {
  createDomainForUser,
  listDomainsForUser,
  listDomainsPageForUser,
} from "@sendcms/domains"
import {
  CreateDomainSchema,
  DomainListQuerySchema,
} from "@sendcms/domains/validators"
import {
  ApiError,
  created,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    // DSH-107: with no query params the bare array is returned (the
    // dashboard hooks' back-compat shape); any param switches to the
    // paged shape, and an unknown or invalid param 422s (strict
    // schema) instead of being silently dropped.
    const query = Object.fromEntries(req.nextUrl.searchParams)
    if (Object.keys(query).length === 0) {
      return ok(await listDomainsForUser(session.user.id))
    }
    const parsed = DomainListQuerySchema.safeParse(query)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    return ok(await listDomainsPageForUser(session.user.id, parsed.data))
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
      return validationErrorResponse(parsed.error)
    }
    const domain = await createDomainForUser(session.user.id, parsed.data)
    revalidatePath("/dashboard", "layout")
    return created(domain)
  } catch (err) {
    return handleApiError(err)
  }
}
