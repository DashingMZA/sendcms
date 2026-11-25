import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { createTicket, listMyTickets } from "@sendcms/support"
import {
  CreateTicketSchema,
  MyTicketsQuerySchema,
} from "@sendcms/support/validators"
import {
  ApiError,
  created,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// The customer's own support tickets. A signed-in user lists and
// creates only their own tickets — there is no public or anonymous
// ticket form anywhere.
export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const parsed = MyTicketsQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const result = await listMyTickets(session.user.id, parsed.data)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const body = await req.json().catch(() => ({}))
    const parsed = CreateTicketSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const ticket = await createTicket(session.user.id, parsed.data)
    return created(ticket)
  } catch (err) {
    return handleApiError(err)
  }
}
