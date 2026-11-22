import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { getMyTicket } from "@sendcms/support"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// One of the caller's own tickets, with the full thread. Another
// user's ticket is a 404 here — the service never leaks its existence.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { ticketId } = await params
    const ticket = await getMyTicket(session.user.id, ticketId)
    return ok(ticket)
  } catch (err) {
    return handleApiError(err)
  }
}
