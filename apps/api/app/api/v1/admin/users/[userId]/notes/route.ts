import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { addAdminNote, listAdminNotes } from "@sendcms/admin-users"
import {
  AddAdminNoteSchema,
  AdminNotesQuerySchema,
} from "@sendcms/admin-users/validators"
import { ApiError, created, handleApiError, ok } from "@sendcms/api-client"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { userId } = await params
    const parsed = AdminNotesQuerySchema.safeParse(
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
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { userId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = AddAdminNoteSchema.safeParse(body)
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
    const note = await addAdminNote(session, userId, parsed.data)
    return created(note)
  } catch (err) {
    return handleApiError(err)
  }
}
