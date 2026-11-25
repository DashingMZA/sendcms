import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { adminReply } from "@sendcms/support"
import { ReplyToTicketSchema } from "@sendcms/support/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// A staff reply to a ticket. MANAGE_USERS holders and SUPPORT-role
// staff may reply (enforced at the route and in the service).
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
    const parsed = ReplyToTicketSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const ticket = await adminReply(session, ticketId, parsed.data)
    return ok(ticket)
  } catch (err) {
    return handleApiError(err)
  }
}
