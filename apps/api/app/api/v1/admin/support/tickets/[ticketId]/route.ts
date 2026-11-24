import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getTicket } from "@sendcms/support"
import { handleApiError, ok } from "@sendcms/api-client"

// Any user's ticket, with the full thread. Reads need
// VIEW_CUSTOMER_DATA (enforced at the route and in the service).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const session = await requireAdminApi("VIEW_CUSTOMER_DATA")
    const rateLimited = await enforceAdminApiRateLimit(_req, session.user.id)
    if (rateLimited) return rateLimited
    const { ticketId } = await params
    const ticket = await getTicket(session, ticketId)
    return ok(ticket)
  } catch (err) {
    return handleApiError(err)
  }
}
