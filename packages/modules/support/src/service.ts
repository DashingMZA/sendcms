import type { AdminSession } from "@sendcms/auth"
import { AuditAction, AuditResource, db, Prisma } from "@sendcms/database"
import type {
  AdminRole,
  PlatformRole,
  TicketPriority,
  TicketStatus,
} from "@sendcms/database"
import { getEffectiveRole, requireAdmin } from "@sendcms/permissions"
import { logAudit } from "@sendcms/security"
import { ApiError } from "@sendcms/shared"
import type {
  AdminTicketsQuery,
  AssignTicketInput,
  CreateTicketInput,
  MyTicketsQuery,
  ReplyToTicketInput,
  SetTicketStatusInput,
} from "./validators"
import { TICKET_TRANSITIONS } from "./transitions"

// Support ticket system (Admin Control Plane, Phase 8).
// Framework-independent (no Next.js imports); only services import
// @sendcms/database. Authorization lives HERE, not in the routes.
//
// The core invariants:
// - Tickets are created by SIGNED-IN users from the dashboard only.
//   There is no public/anonymous ticket form on marketing, and no
//   route here accepts a ticket from an unauthenticated caller.
// - A customer sees and touches ONLY their own tickets. Another
//   user's ticket is a 404 to them — never a 403 that leaks that the
//   ticket exists.
// - CLOSED is terminal: a closed ticket is never replied to or
//   reopened. The customer opens a new ticket instead.
// - A customer reply to a RESOLVED ticket reopens it to OPEN. An
//   admin reply never reopens a resolved ticket — the admin reopens
//   it with an explicit status change, or the customer reopens it by
//   replying.
// - Audit detail never carries a message body — only the subject,
//   the status/priority values, and the reason. Ticket bodies may
//   hold sensitive customer information.
// - Admin reads need VIEW_CUSTOMER_DATA. Ticket writes — reply,
//   status change, assignment, and the staff list for the assign
//   picker — need MANAGE_USERS or the SUPPORT role. Support staff
//   exist to answer tickets and queries (owner decision,
//   2026-11-22).

// ─── Authorization ────────────────────────────────────────────────────

// The admin gate lives in `@sendcms/permissions` (Phase 16, Wave 2 —
// SRC-215 / SRC-411): one implementation for every module, re-exported
// here so existing import paths keep working.
export { getEffectiveRole, requireAdmin } from "@sendcms/permissions"

// Throws 403 unless the actor may write to a ticket (reply, status
// change, assignment): MANAGE_USERS holders, or SUPPORT-role staff.
// Support staff exist to answer tickets and queries, so ticket work
// is part of their job.
export function requireTicketWrite(session: AdminSession): void {
  if (getEffectiveRole(session) === "SUPPORT") return
  requireAdmin(session, "MANAGE_USERS")
}

// ─── Row shapes ───────────────────────────────────────────────────────

type TicketUserRef = {
  id: string
  name: string | null
  email: string
} | null

export type TicketMessageRow = {
  id: string
  authorId: string | null
  author: TicketUserRef
  body: string
  createdAt: Date
}

export type TicketRow = {
  id: string
  userId: string
  user: TicketUserRef
  subject: string
  status: TicketStatus
  priority: TicketPriority
  assignedToId: string | null
  assignedTo: TicketUserRef
  createdAt: Date
  updatedAt: Date
  messageCount: number
}

export type TicketDetailRow = TicketRow & { messages: TicketMessageRow[] }

export type StaffUserRow = {
  id: string
  name: string | null
  email: string
  platformRole: PlatformRole
  adminRole: AdminRole | null
}

type TicketListPayload = Prisma.SupportTicketGetPayload<{
  include: {
    user: { select: { id: true; name: true; email: true } }
    assignedTo: { select: { id: true; name: true; email: true } }
    _count: { select: { messages: true } }
  }
}>

type TicketDetailPayload = Prisma.SupportTicketGetPayload<{
  include: {
    user: { select: { id: true; name: true; email: true } }
    assignedTo: { select: { id: true; name: true; email: true } }
    messages: {
      include: { author: { select: { id: true; name: true; email: true } } }
      orderBy: { createdAt: "asc" }
    }
    _count: { select: { messages: true } }
  }
}>

function toTicketRow(row: TicketListPayload): TicketRow {
  return {
    id: row.id,
    userId: row.userId,
    user: row.user,
    subject: row.subject,
    status: row.status,
    priority: row.priority,
    assignedToId: row.assignedToId,
    assignedTo: row.assignedTo,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messageCount: row._count.messages,
  }
}

function toTicketDetailRow(row: TicketDetailPayload): TicketDetailRow {
  return {
    ...toTicketRow(row),
    messages: row.messages.map((m) => ({
      id: m.id,
      authorId: m.authorId,
      author: m.author,
      body: m.body,
      createdAt: m.createdAt,
    })),
  }
}

// ─── Row locking (DB-026) ────────────────────────────────────────────

// A plain in-transaction findUnique does NOT serialize writers under
// Postgres READ COMMITTED: two concurrent transactions can both read
// the same status, both validate, and both apply their write — the
// second UPDATE re-evaluates against the new row version and still
// succeeds. Verified live 2026-11-25 against Postgres 16: with the
// bare findUnique, two concurrent OPEN → RESOLVED calls BOTH
// fulfilled, and a reply racing a close resurrected the ticket — the
// reply's stale no-op status write (OPEN) landed after the close's
// CLOSED write. SELECT ... FOR UPDATE (the DB-051 idiom in
// platform-ops/src/flags.ts) makes the second transaction wait on
// the row, then read the committed status, so the loser sees the
// real outcome and gets the 409.
type LockedTicketRow = {
  id: string
  userId: string
  status: TicketStatus
}

async function lockTicketRow(
  tx: Prisma.TransactionClient,
  ticketId: string
): Promise<LockedTicketRow | null> {
  const locked = await tx.$queryRaw<LockedTicketRow[]>`
    SELECT "id", "userId", "status" FROM "SupportTicket" WHERE "id" = ${ticketId} FOR UPDATE
  `
  return locked[0] ?? null
}

// ─── Customer ─────────────────────────────────────────────────────────

/** Creates a ticket + its first message in ONE transaction, then
    audits the creation. The message body is never in the audit. */
export async function createTicket(
  userId: string,
  input: CreateTicketInput
): Promise<TicketDetailRow> {
  // SRC-236: a suspended/disabled user cannot file tickets
  // (contrast saveUserAiKey, which asserts not-suspended). Checked
  // BEFORE the transaction — the user lookup used to live inside it
  // (SRC-238), where it only echoed the author back.
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, status: true },
  })
  if (!user) throw new ApiError("User not found.", 404)
  if (user.status !== "ACTIVE") {
    throw new ApiError("A suspended account cannot open a support ticket.", 403)
  }
  const created = await db.$transaction(async (tx) => {
    const ticket = await tx.supportTicket.create({
      data: {
        userId,
        subject: input.subject,
        priority: input.priority,
      },
    })
    const message = await tx.ticketMessage.create({
      data: { ticketId: ticket.id, authorId: userId, body: input.body },
    })
    return { ticket, message }
  })
  await logAudit({
    userId,
    action: AuditAction.CREATE,
    resourceType: AuditResource.SUPPORT_TICKET,
    resourceId: created.ticket.id,
    detail: {
      event: "ticket-created",
      subject: input.subject,
      priority: input.priority,
    },
  })
  const author = { id: user.id, name: user.name, email: user.email }
  return {
    id: created.ticket.id,
    userId,
    user: author,
    subject: created.ticket.subject,
    status: created.ticket.status,
    priority: created.ticket.priority,
    assignedToId: null,
    assignedTo: null,
    createdAt: created.ticket.createdAt,
    updatedAt: created.ticket.updatedAt,
    messageCount: 1,
    messages: [
      {
        id: created.message.id,
        authorId: created.message.authorId,
        author,
        body: created.message.body,
        createdAt: created.message.createdAt,
      },
    ],
  }
}

export type MyTicketsPage = {
  tickets: TicketRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

/** The caller's own tickets, newest first. Ownership is the filter —
    no capability check: any signed-in user may list their own. */
export async function listMyTickets(
  userId: string,
  filters: MyTicketsQuery
): Promise<MyTicketsPage> {
  const where: Prisma.SupportTicketWhereInput = { userId }
  if (filters.status) where.status = filters.status
  if (filters.search) {
    where.subject = { contains: filters.search, mode: "insensitive" }
  }
  const [total, rows] = await Promise.all([
    db.supportTicket.count({ where }),
    db.supportTicket.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
        _count: { select: { messages: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.perPage,
      take: filters.perPage,
    }),
  ])
  return {
    tickets: rows.map(toTicketRow),
    total,
    page: filters.page,
    perPage: filters.perPage,
    totalPages: Math.max(1, Math.ceil(total / filters.perPage)),
  }
}

/** One of the caller's own tickets with the full thread, oldest
    message first. 404 when missing or owned by someone else. */
export async function getMyTicket(
  userId: string,
  ticketId: string
): Promise<TicketDetailRow> {
  // SRC-236: one query, not two — the existence/ownership check used
  // to fetch the row and then fetch the same row again with includes.
  const row = await db.supportTicket.findUnique({
    where: { id: ticketId },
    include: {
      user: { select: { id: true, name: true, email: true } },
      assignedTo: { select: { id: true, name: true, email: true } },
      messages: {
        include: {
          author: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "asc" },
      },
      _count: { select: { messages: true } },
    },
  })
  if (!row || row.userId !== userId) {
    throw new ApiError("Ticket not found.", 404)
  }
  return toTicketDetailRow(row)
}

/** Appends the caller's reply. Replying to a RESOLVED ticket reopens
    it to OPEN; replying to a CLOSED ticket is refused (409) — closed
    is terminal, open a new ticket instead. Audited.
    DB-026: the ownership + CLOSED checks and the write all happen
    inside ONE transaction, and the ticket row is read under a
    FOR UPDATE lock (lockTicketRow) — a ticket closed between an
    outside guard read and the write used to still get the reply
    appended (the CLOSED guard was evaluated on a stale read), and a
    bare in-transaction read still let a stale status write land
    after the close. Now the loser of the race sees the committed
    CLOSED status and gets the 409, with no message row written. */
export async function replyToTicket(
  userId: string,
  ticketId: string,
  input: ReplyToTicketInput
): Promise<TicketDetailRow> {
  const { updated, reopened } = await db.$transaction(
    async (tx) => {
      const ticket = await lockTicketRow(tx, ticketId)
      if (!ticket || ticket.userId !== userId) {
        throw new ApiError("Ticket not found.", 404)
      }
      if (ticket.status === "CLOSED") {
        throw new ApiError(
          "This ticket is closed. Please open a new ticket if you still need help.",
          409
        )
      }
      const reopened = ticket.status === "RESOLVED"
      await tx.ticketMessage.create({
        data: { ticketId: ticket.id, authorId: userId, body: input.body },
      })
      const updated = await tx.supportTicket.update({
        where: { id: ticket.id },
        data: { status: reopened ? "OPEN" : ticket.status },
        include: {
          user: { select: { id: true, name: true, email: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
          messages: {
            include: {
              author: { select: { id: true, name: true, email: true } },
            },
            orderBy: { createdAt: "asc" },
          },
          _count: { select: { messages: true } },
        },
      })
      return { updated, reopened }
    },
    // Same headroom as the flag toggles (platform-ops/src/flags.ts):
    // the loser of a race on one ticket's row needs more than
    // Prisma's 2s default start window.
    { maxWait: 20000, timeout: 30000 }
  )
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.SUPPORT_TICKET,
    resourceId: ticketId,
    detail: {
      event: "ticket-replied",
      by: "customer",
      reopened,
    },
  })
  return toTicketDetailRow(updated)
}

// ─── Admin ────────────────────────────────────────────────────────────

export type AdminTicketsPage = {
  tickets: TicketRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

/** New-ticket count for the admin shell (DSH-406 — owner decision
    2026-11-25, option (b): admin-shell new-ticket counts, NOT
    email/notification). "New" is status OPEN: a ticket the customer
    opened that staff have not started on. Resolving or closing it
    drops the count; a customer reply that reopens a RESOLVED ticket
    brings it back. Reads need VIEW_CUSTOMER_DATA, like the queue
    itself. One cheap count query — the shell calls this on every
    admin page render. */
export async function countNewTickets(actor: AdminSession): Promise<number> {
  requireAdmin(actor, "VIEW_CUSTOMER_DATA")
  return db.supportTicket.count({ where: { status: "OPEN" } })
}

/** Every user's tickets, newest first. Reads need
    VIEW_CUSTOMER_DATA. Search matches the subject, case-insensitive. */
export async function listTickets(
  actor: AdminSession,
  filters: AdminTicketsQuery
): Promise<AdminTicketsPage> {
  requireAdmin(actor, "VIEW_CUSTOMER_DATA")
  const where: Prisma.SupportTicketWhereInput = {}
  if (filters.status) where.status = filters.status
  if (filters.priority) where.priority = filters.priority
  if (filters.assignedToId) where.assignedToId = filters.assignedToId
  if (filters.search) {
    where.subject = { contains: filters.search, mode: "insensitive" }
  }
  const [total, rows] = await Promise.all([
    db.supportTicket.count({ where }),
    db.supportTicket.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
        _count: { select: { messages: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.perPage,
      take: filters.perPage,
    }),
  ])
  return {
    tickets: rows.map(toTicketRow),
    total,
    page: filters.page,
    perPage: filters.perPage,
    totalPages: Math.max(1, Math.ceil(total / filters.perPage)),
  }
}

async function getTicketOrThrow(ticketId: string) {
  const ticket = await db.supportTicket.findUnique({
    where: { id: ticketId },
  })
  if (!ticket) throw new ApiError("Ticket not found.", 404)
  return ticket
}

/** Any user's ticket with the full thread. Reads need
    VIEW_CUSTOMER_DATA. */
export async function getTicket(
  actor: AdminSession,
  ticketId: string
): Promise<TicketDetailRow> {
  requireAdmin(actor, "VIEW_CUSTOMER_DATA")
  // SRC-236: one query, not two — the existence check used to fetch
  // the row and then fetch the same row again with includes.
  const row = await db.supportTicket.findUnique({
    where: { id: ticketId },
    include: {
      user: { select: { id: true, name: true, email: true } },
      assignedTo: { select: { id: true, name: true, email: true } },
      messages: {
        include: {
          author: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "asc" },
      },
      _count: { select: { messages: true } },
    },
  })
  if (!row) throw new ApiError("Ticket not found.", 404)
  return toTicketDetailRow(row)
}

/** A staff reply. The reply moves OPEN / IN_PROGRESS /
    WAITING_ON_CUSTOMER tickets to IN_PROGRESS; a RESOLVED ticket
    stays RESOLVED (the admin reopens it with an explicit status
    change, or the customer reopens it by replying). Replying to a
    CLOSED ticket is refused (409). Replying needs MANAGE_USERS or
    the SUPPORT role. DB-026: like replyToTicket, the CLOSED check
    and the write share one transaction under a FOR UPDATE row lock
    (lockTicketRow) — a close racing this reply can no longer be
    silently overwritten by a stale status write. */
export async function adminReply(
  actor: AdminSession,
  ticketId: string,
  input: ReplyToTicketInput
): Promise<TicketDetailRow> {
  requireTicketWrite(actor)
  const { updated, nextStatus, oldStatus } = await db.$transaction(
    async (tx) => {
      const ticket = await lockTicketRow(tx, ticketId)
      if (!ticket) throw new ApiError("Ticket not found.", 404)
      if (ticket.status === "CLOSED") {
        throw new ApiError("This ticket is closed.", 409)
      }
      const nextStatus =
        ticket.status === "RESOLVED" ? "RESOLVED" : "IN_PROGRESS"
      await tx.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          authorId: actor.user.id,
          body: input.body,
        },
      })
      const updated = await tx.supportTicket.update({
        where: { id: ticket.id },
        data: { status: nextStatus },
        include: {
          user: { select: { id: true, name: true, email: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
          messages: {
            include: {
              author: { select: { id: true, name: true, email: true } },
            },
            orderBy: { createdAt: "asc" },
          },
          _count: { select: { messages: true } },
        },
      })
      return { updated, nextStatus, oldStatus: ticket.status }
    },
    { maxWait: 20000, timeout: 30000 }
  )
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.SUPPORT_TICKET,
    resourceId: ticketId,
    detail: {
      event: "ticket-replied",
      by: "admin",
      statusChanged: nextStatus !== oldStatus,
    },
  })
  return toTicketDetailRow(updated)
}

/** Moves a ticket along the status machine. Only the transitions in
    TICKET_TRANSITIONS are allowed — anything else is a 409. Reason
    required. Needs MANAGE_USERS or the SUPPORT role. DB-026: the
    read, the transition check, and the write share one transaction
    under a FOR UPDATE row lock (lockTicketRow), so the transition is
    validated against the status it actually replaces — two
    concurrent calls can no longer both validate against the same
    stale status and both apply. */
export async function setTicketStatus(
  actor: AdminSession,
  ticketId: string,
  input: SetTicketStatusInput
): Promise<TicketDetailRow> {
  requireTicketWrite(actor)
  const { updated, oldStatus } = await db.$transaction(
    async (tx) => {
      const ticket = await lockTicketRow(tx, ticketId)
      if (!ticket) throw new ApiError("Ticket not found.", 404)
      if (!TICKET_TRANSITIONS[ticket.status].includes(input.status)) {
        throw new ApiError(
          `Cannot move a ${ticket.status} ticket to ${input.status}.`,
          409
        )
      }
      const updated = await tx.supportTicket.update({
        where: { id: ticket.id },
        data: { status: input.status },
        include: {
          user: { select: { id: true, name: true, email: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
          messages: {
            include: {
              author: { select: { id: true, name: true, email: true } },
            },
            orderBy: { createdAt: "asc" },
          },
          _count: { select: { messages: true } },
        },
      })
      return { updated, oldStatus: ticket.status }
    },
    { maxWait: 20000, timeout: 30000 }
  )
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.SUPPORT_TICKET,
    resourceId: ticketId,
    detail: {
      event: "ticket-status-changed",
      reason: input.reason,
      oldStatus,
      newStatus: input.status,
    },
  })
  return toTicketDetailRow(updated)
}

/** Assigns a ticket to a staff user — the platform owner or a user
    holding a staff adminRole. Anyone else is a 422. Reason required.
    Needs MANAGE_USERS or the SUPPORT role. */
export async function assignTicket(
  actor: AdminSession,
  ticketId: string,
  input: AssignTicketInput
): Promise<TicketDetailRow> {
  requireTicketWrite(actor)
  const ticket = await getTicketOrThrow(ticketId)
  const assignee = await db.user.findUnique({
    where: { id: input.assignedToId },
    select: { id: true, platformRole: true, adminRole: true },
  })
  if (!assignee) throw new ApiError("User not found.", 404)
  const isStaff =
    assignee.platformRole === "PLATFORM_OWNER" || assignee.adminRole !== null
  if (!isStaff) {
    throw new ApiError(
      "Tickets can only be assigned to platform staff (the owner or a staff admin role).",
      422
    )
  }
  const updated = await db.supportTicket.update({
    where: { id: ticket.id },
    data: { assignedToId: assignee.id },
    include: {
      user: { select: { id: true, name: true, email: true } },
      assignedTo: { select: { id: true, name: true, email: true } },
      messages: {
        include: {
          author: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "asc" },
      },
      _count: { select: { messages: true } },
    },
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.ASSIGN,
    resourceType: AuditResource.SUPPORT_TICKET,
    resourceId: ticket.id,
    detail: {
      event: "ticket-assigned",
      reason: input.reason,
      oldAssigneeId: ticket.assignedToId,
      newAssigneeId: assignee.id,
    },
  })
  return toTicketDetailRow(updated)
}

/** Every staff user (owner + adminRole holders), for the assign
    picker. Needs MANAGE_USERS or the SUPPORT role — the picker is
    only shown where the actor may assign. */
export async function listStaffUsers(
  actor: AdminSession
): Promise<StaffUserRow[]> {
  requireTicketWrite(actor)
  return db.user.findMany({
    where: {
      OR: [{ platformRole: "PLATFORM_OWNER" }, { adminRole: { not: null } }],
    },
    select: {
      id: true,
      name: true,
      email: true,
      platformRole: true,
      adminRole: true,
    },
    orderBy: { name: "asc" },
  })
}
