import { NextRequest, NextResponse } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { setTicketStatus } from "@sendcms/support"
import { SetTicketStatusSchema } from "@sendcms/support/validators"
import { handleApiError, ok } from "@sendcms/api-client"

// Moves a ticket along the status machine. Only the transitions the
// service allows succeed — anything else is a 409. Writes need
// MANAGE_USERS or the SUPPORT role (enforced at the route and in the service).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const session = await requireAdminApi("VIEW_CUSTOMER_DATA")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { ticketId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = SetTicketStatusSchema.safeParse(body)
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
    const ticket = await setTicketStatus(session, ticketId, parsed.data)
    return ok(ticket)
  } catch (err) {
    return handleApiError(err)
  }
}
