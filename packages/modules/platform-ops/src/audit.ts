import type { AdminSession } from "@sendcms/auth"
import {
  AuditAction,
  AuditOutcome,
  AuditResource,
  Prisma,
  db,
} from "@sendcms/database"
import { ApiError } from "@sendcms/shared"
import type { AuditLogsQuery } from "./validators"
import { requireAdmin } from "./require-admin"

// Audit trail explorer (Admin Control Plane, Phase 7).
// Framework-independent (no Next.js imports); only services import
// @sendcms/database.
//
// The AuditLog is append-only: this module has NO update or delete
// function for it, by design. Admins cannot silently edit or delete
// historical audit records through any interface this module offers
// (the test suite proves the module exports no AuditLog mutation).
// Services must never put secrets in `detail` — no passwords, tokens,
// keys, or raw submission content; the export returns the rows as
// stored, so what is never written can never leak.

export type AuditLogRow = {
  id: string
  action: string
  resourceType: string
  resourceId: string
  detail: Prisma.JsonValue | null
  ipAddress: string | null
  reason: string | null
  correlationId: string | null
  outcome: string
  createdAt: Date
  actor: { id: string; name: string | null; email: string } | null
}

const auditLogSelect = {
  id: true,
  action: true,
  resourceType: true,
  resourceId: true,
  detail: true,
  ipAddress: true,
  reason: true,
  correlationId: true,
  outcome: true,
  createdAt: true,
} as const

function toAuditLogRow(row: {
  id: string
  action: string
  resourceType: string
  resourceId: string
  detail: Prisma.JsonValue | null
  ipAddress: string | null
  reason: string | null
  correlationId: string | null
  outcome: string
  createdAt: Date
  user: { id: string; name: string | null; email: string } | null
}): AuditLogRow {
  const { user, ...rest } = row
  return { ...rest, actor: user }
}

// A bad filter value is a 422, not a Prisma error — the enums are
// checked against the live values, never a second copy of the list.
function auditLogsWhere(filters: AuditLogsQuery): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {}
  if (filters.actorId) where.userId = filters.actorId
  if (filters.targetUserId) {
    // A user-targeted action is recorded as resourceType USER with
    // the target's id as resourceId; the actor is the row's userId.
    where.resourceType = "USER"
    where.resourceId = filters.targetUserId
  }
  if (filters.action) {
    if (!(Object.values(AuditAction) as string[]).includes(filters.action)) {
      throw new ApiError(`Unknown audit action: ${filters.action}.`, 422)
    }
    where.action = filters.action as AuditAction
  }
  if (filters.resourceType) {
    if (
      !(Object.values(AuditResource) as string[]).includes(filters.resourceType)
    ) {
      throw new ApiError(
        `Unknown audit resource: ${filters.resourceType}.`,
        422
      )
    }
    where.resourceType = filters.resourceType as AuditResource
  }
  if (filters.outcome) {
    if (!(Object.values(AuditOutcome) as string[]).includes(filters.outcome)) {
      throw new ApiError(`Unknown audit outcome: ${filters.outcome}.`, 422)
    }
    where.outcome = filters.outcome as AuditOutcome
  }
  if (filters.correlationId) where.correlationId = filters.correlationId
  const createdAt: Prisma.DateTimeFilter = {}
  if (filters.from) {
    const d = new Date(filters.from)
    if (!Number.isNaN(d.getTime())) createdAt.gte = d
  }
  if (filters.to) {
    const d = new Date(filters.to)
    if (!Number.isNaN(d.getTime())) createdAt.lte = d
  }
  if (Object.keys(createdAt).length > 0) where.createdAt = createdAt
  return where
}

/** Paginated audit history, newest first. Reads need VIEW_AUDIT_LOGS.
    `targetUserId` finds actions taken ABOUT a user (resourceType USER);
    `actorId` finds actions taken BY an administrator. */
export async function listAuditLogs(
  actor: AdminSession,
  filters: AuditLogsQuery
): Promise<{
  logs: AuditLogRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "VIEW_AUDIT_LOGS")
  const where = auditLogsWhere(filters)
  const [total, rows] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({
      where,
      select: {
        ...auditLogSelect,
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.perPage,
      take: filters.perPage,
    }),
  ])
  return {
    logs: rows.map(toAuditLogRow),
    total,
    page: filters.page,
    perPage: filters.perPage,
    totalPages: Math.max(1, Math.ceil(total / filters.perPage)),
  }
}

/** One audit event with its actor. Reads need VIEW_AUDIT_LOGS. */
export async function getAuditLog(
  actor: AdminSession,
  id: string
): Promise<AuditLogRow> {
  requireAdmin(actor, "VIEW_AUDIT_LOGS")
  const row = await db.auditLog.findUnique({
    where: { id },
    select: {
      ...auditLogSelect,
      user: { select: { id: true, name: true, email: true } },
    },
  })
  if (!row) throw new ApiError("Audit log entry not found.", 404)
  return toAuditLogRow(row)
}

/** The same filtered rows as JSON, for export (downloaded by the
    admin UI). Reads need EXPORT_AUDIT_LOGS. The rows are returned as
    stored — safe only because services never write secrets into
    `detail` (see the module header). No update/delete exists, so an
    export can never be used to rewrite history. */
export async function exportAuditLogs(
  actor: AdminSession,
  filters: AuditLogsQuery
): Promise<{ logs: AuditLogRow[]; total: number; exportedAt: Date }> {
  requireAdmin(actor, "EXPORT_AUDIT_LOGS")
  const where = auditLogsWhere(filters)
  const rows = await db.auditLog.findMany({
    where,
    select: {
      ...auditLogSelect,
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
  })
  return {
    logs: rows.map(toAuditLogRow),
    total: rows.length,
    exportedAt: new Date(),
  }
}
