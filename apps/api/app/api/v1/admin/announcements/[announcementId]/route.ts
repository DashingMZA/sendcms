import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import {
  getAnnouncement,
  setAnnouncementActive,
  updateAnnouncement,
} from "@sendcms/platform-ops"
import {
  SetAnnouncementActiveSchema,
  UpdateAnnouncementBodySchema,
} from "@sendcms/platform-ops/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// One announcement: GET the row, PATCH to edit fields or to flip the
// active switch (when `isActive` is present the toggle wins and the
// reason is required; otherwise the field update runs).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ announcementId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const rateLimited = await enforceAdminApiRateLimit(_req, session.user.id)
    if (rateLimited) return rateLimited
    const { announcementId } = await params
    const announcement = await getAnnouncement(session, announcementId)
    return ok(announcement)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ announcementId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { announcementId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = UpdateAnnouncementBodySchema.safeParse(body)
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
    const correlationId = randomUUID()
    if (parsed.data.isActive !== undefined) {
      const active = SetAnnouncementActiveSchema.safeParse({
        isActive: parsed.data.isActive,
        reason: parsed.data.reason,
      })
      if (!active.success) {
        const flat = active.error.flatten()
        const messages = [
          ...flat.formErrors,
          ...Object.values(flat.fieldErrors).flat(),
        ].filter(Boolean)
        return NextResponse.json(
          { error: messages.join("; ") || "Validation failed" },
          { status: 422 }
        )
      }
      const announcement = await setAnnouncementActive(
        session,
        announcementId,
        active.data,
        { correlationId }
      )
      return ok(announcement)
    }
    // The toggle branch above already returned when `isActive` was
    // present, so only the editable fields go to the service here.
    const announcement = await updateAnnouncement(
      session,
      announcementId,
      {
        title: parsed.data.title,
        body: parsed.data.body,
        audience: parsed.data.audience,
        startsAt: parsed.data.startsAt,
        endsAt: parsed.data.endsAt,
      },
      { correlationId }
    )
    return ok(announcement)
  } catch (err) {
    return handleApiError(err)
  }
}
