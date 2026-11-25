import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { createAnnouncement, listAnnouncements } from "@sendcms/platform-ops"
import {
  AnnouncementsQuerySchema,
  CreateAnnouncementSchema,
} from "@sendcms/platform-ops/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("MANAGE_ANNOUNCEMENTS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = AnnouncementsQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const result = await listAnnouncements(session, parsed.data)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApi("MANAGE_ANNOUNCEMENTS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const body = await req.json().catch(() => ({}))
    const parsed = CreateAnnouncementSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const announcement = await createAnnouncement(session, parsed.data, {
      correlationId: randomUUID(),
    })
    return ok(announcement)
  } catch (err) {
    return handleApiError(err)
  }
}
