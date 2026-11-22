import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { replyToTicket } from "@sendcms/support"
import { ReplyToTicketSchema } from "@sendcms/support/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// The caller's reply to their own ticket. Replying to a RESOLVED
// ticket reopens it; replying to a CLOSED ticket is refused (409).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { ticketId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = ReplyToTicketSchema.safeParse(body)
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
    const ticket = await replyToTicket(session.user.id, ticketId, parsed.data)
    return ok(ticket)
  } catch (err) {
    return handleApiError(err)
  }
}
