import type { AdminSession } from "@sendcms/auth"
import {
  AuditAction,
  AuditResource,
  Prisma,
  type AnnouncementAudience,
  db,
} from "@sendcms/database"
import { logAudit } from "@sendcms/security"
import { ApiError } from "@sendcms/shared"
import type {
  CreateAnnouncementInput,
  SetAnnouncementActiveInput,
  UpdateAnnouncementInput,
} from "./validators"
import { requireAdmin, type AuditOpts } from "./require-admin"

// Platform announcements (Admin Control Plane, Phase 7).
// Framework-independent (no Next.js imports); only services import
// @sendcms/database. Authorization lives HERE, not in the routes.
//
// Active = isActive AND inside the optional [startsAt, endsAt]
// window. Audience ALL shows on the customer dashboard banner AND
// the admin overview; ADMIN_ONLY shows only in the admin app.
// Announcements are never sent by email — they are read from the
// active-announcements endpoint. They are never deleted: deactivation
// is the way to take one down, so the record survives.

export type AnnouncementRow = {
  id: string
  title: string
  body: string
  audience: AnnouncementAudience
  isActive: boolean
  startsAt: Date | null
  endsAt: Date | null
  createdBy: { id: string; name: string | null; email: string } | null
  createdAt: Date
  updatedAt: Date
}

function toAnnouncementRow(row: {
  id: string
  title: string
  body: string
  audience: AnnouncementAudience
  isActive: boolean
  startsAt: Date | null
  endsAt: Date | null
  createdBy: { id: string; name: string | null; email: string } | null
  createdAt: Date
  updatedAt: Date
}): AnnouncementRow {
  return { ...row }
}

// The active window, evaluated against now. A null bound is open.
function activeWindowWhere(now: Date): Prisma.AnnouncementWhereInput {
  return {
    isActive: true,
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
    ],
  }
}

function parseWindowDate(
  value: string | undefined,
  field: string
): Date | undefined {
  if (value === undefined) return undefined
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) {
    throw new ApiError(`${field} must be a valid ISO date.`, 422)
  }
  return d
}

/** Every announcement, newest first, with status/audience filters.
    MANAGE_ANNOUNCEMENTS (the announcements page is a management
    page — owner + SUPER_ADMIN only). */
export async function listAnnouncements(
  actor: AdminSession,
  filters: {
    isActive?: boolean
    audience?: AnnouncementAudience
    page?: number
    perPage?: number
  } = {}
): Promise<{
  announcements: AnnouncementRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "MANAGE_ANNOUNCEMENTS")
  const page = filters.page ?? 1
  const perPage = filters.perPage ?? 20
  const where: Prisma.AnnouncementWhereInput = {}
  if (filters.isActive !== undefined) where.isActive = filters.isActive
  if (filters.audience) where.audience = filters.audience
  const [total, rows] = await Promise.all([
    db.announcement.count({ where }),
    db.announcement.findMany({
      where,
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ])
  return {
    announcements: rows.map(toAnnouncementRow),
    total,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  }
}

async function getAnnouncementOrThrow(id: string) {
  const row = await db.announcement.findUnique({
    where: { id },
    include: { createdBy: { select: { id: true, name: true, email: true } } },
  })
  if (!row) throw new ApiError("Announcement not found.", 404)
  return row
}

/** One announcement by id. MANAGE_ANNOUNCEMENTS. */
export async function getAnnouncement(
  actor: AdminSession,
  id: string
): Promise<AnnouncementRow> {
  requireAdmin(actor, "MANAGE_ANNOUNCEMENTS")
  const row = await getAnnouncementOrThrow(id)
  return toAnnouncementRow(row)
}

/** Creates an announcement (active by default). MANAGE_ANNOUNCEMENTS,
    audited. */
export async function createAnnouncement(
  actor: AdminSession,
  input: CreateAnnouncementInput,
  opts: AuditOpts = {}
): Promise<AnnouncementRow> {
  requireAdmin(actor, "MANAGE_ANNOUNCEMENTS")
  const row = await db.announcement.create({
    data: {
      title: input.title,
      body: input.body,
      audience: input.audience,
      startsAt: parseWindowDate(input.startsAt, "startsAt"),
      endsAt: parseWindowDate(input.endsAt, "endsAt"),
      createdById: actor.user.id,
    },
    include: { createdBy: { select: { id: true, name: true, email: true } } },
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.CREATE,
    resourceType: AuditResource.ANNOUNCEMENT,
    resourceId: row.id,
    detail: { event: "announcement-created", title: row.title },
    correlationId: opts.correlationId,
  })
  return toAnnouncementRow(row)
}

/** Partial update of title / body / audience / window.
    MANAGE_ANNOUNCEMENTS, audited with the old/new values. */
export async function updateAnnouncement(
  actor: AdminSession,
  id: string,
  input: UpdateAnnouncementInput,
  opts: AuditOpts = {}
): Promise<AnnouncementRow> {
  requireAdmin(actor, "MANAGE_ANNOUNCEMENTS")
  const before = await getAnnouncementOrThrow(id)
  const data: Prisma.AnnouncementUpdateInput = {}
  if (input.title !== undefined) data.title = input.title
  if (input.body !== undefined) data.body = input.body
  if (input.audience !== undefined) data.audience = input.audience
  if (input.startsAt !== undefined) {
    data.startsAt =
      input.startsAt === null
        ? null
        : parseWindowDate(input.startsAt, "startsAt")
  }
  if (input.endsAt !== undefined) {
    data.endsAt =
      input.endsAt === null ? null : parseWindowDate(input.endsAt, "endsAt")
  }
  const row = await db.announcement.update({
    where: { id },
    data,
    include: { createdBy: { select: { id: true, name: true, email: true } } },
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.ANNOUNCEMENT,
    resourceId: id,
    detail: {
      event: "announcement-updated",
      old: {
        title: before.title,
        audience: before.audience,
        startsAt: before.startsAt,
        endsAt: before.endsAt,
      },
      new: {
        title: row.title,
        audience: row.audience,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
      },
    },
    correlationId: opts.correlationId,
  })
  return toAnnouncementRow(row)
}

/** Publishes / deactivates an announcement. MANAGE_ANNOUNCEMENTS,
    reason required, audited. There is no delete endpoint —
    deactivation is the way to take one down. */
export async function setAnnouncementActive(
  actor: AdminSession,
  id: string,
  input: SetAnnouncementActiveInput,
  opts: AuditOpts = {}
): Promise<AnnouncementRow> {
  requireAdmin(actor, "MANAGE_ANNOUNCEMENTS")
  const before = await getAnnouncementOrThrow(id)
  const row = await db.announcement.update({
    where: { id },
    data: { isActive: input.isActive },
    include: { createdBy: { select: { id: true, name: true, email: true } } },
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.ANNOUNCEMENT,
    resourceId: id,
    detail: {
      event: "announcement-active-changed",
      reason: input.reason,
      oldIsActive: before.isActive,
      newIsActive: row.isActive,
    },
    reason: input.reason,
    correlationId: opts.correlationId,
  })
  return toAnnouncementRow(row)
}

/** The announcements a caller may see right now: active AND inside
    the window. No actor, no capability — the ROUTE decides the
    audience: admin callers pass includeAdminOnly true (ALL +
    ADMIN_ONLY), customer callers pass false (ALL only). */
export async function listActiveAnnouncements(
  includeAdminOnly: boolean
): Promise<{ announcements: AnnouncementRow[] }> {
  const where = activeWindowWhere(new Date())
  if (!includeAdminOnly) where.audience = "ALL"
  const rows = await db.announcement.findMany({
    where,
    include: { createdBy: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "desc" },
  })
  return { announcements: rows.map(toAnnouncementRow) }
}
