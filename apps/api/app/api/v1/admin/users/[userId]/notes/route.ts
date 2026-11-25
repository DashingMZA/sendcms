import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { addAdminNote, listAdminNotes } from "@sendcms/admin-users"
import {
  AddAdminNoteSchema,
  AdminNotesQuerySchema,
} from "@sendcms/admin-users/validators"
import {
  created,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const session = await requireAdminApi("VIEW_USERS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { userId } = await params
    const parsed = AdminNotesQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const notes = await listAdminNotes(session, userId, parsed.data)
    return ok(notes)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const session = await requireAdminApi("MANAGE_USERS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { userId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = AddAdminNoteSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const note = await addAdminNote(session, userId, parsed.data)
    return created(note)
  } catch (err) {
    return handleApiError(err)
  }
}
