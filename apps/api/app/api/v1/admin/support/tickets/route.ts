import { NextRequest, NextResponse } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listTickets } from "@sendcms/support"
import { AdminTicketsQuerySchema } from "@sendcms/support/validators"
import { handleApiError, ok } from "@sendcms/api-client"

// Every user's tickets, newest first. Reads need VIEW_CUSTOMER_DATA
// (enforced at the route and in the service).
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_CUSTOMER_DATA")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = AdminTicketsQuerySchema.safeParse(
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
    const result = await listTickets(session, parsed.data)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
