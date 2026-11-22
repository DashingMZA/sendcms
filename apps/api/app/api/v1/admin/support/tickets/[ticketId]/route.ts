import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getTicket } from "@sendcms/support"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Any user's ticket, with the full thread. Reads need
// VIEW_CUSTOMER_DATA (enforced in the service).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const rateLimited = await enforceAdminApiRateLimit(_req, session.user.id)
    if (rateLimited) return rateLimited
    const { ticketId } = await params
    const ticket = await getTicket(session, ticketId)
    return ok(ticket)
  } catch (err) {
    return handleApiError(err)
  }
}
