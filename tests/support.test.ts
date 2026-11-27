// Support ticket service gates (Phase 8) with a mocked Prisma client.
// No test hits the real DB.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockLogAudit = vi.hoisted(() => vi.fn(async () => {}))

const mockDb = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  supportTicket: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  ticketMessage: { create: vi.fn() },
  // DB-026: the service locks the ticket row with SELECT ... FOR
  // UPDATE. The mock returns the same row findUnique would — the
  // per-test findUnique mockResolvedValue is the locked row.
  $queryRaw: vi.fn(async () => {
    const row = await mockDb.supportTicket.findUnique()
    return row ? [{ id: row.id, userId: row.userId, status: row.status }] : []
  }),
  // Array form (reply/status/assign run message + update together):
  // the array already holds the mock calls' promises, so await them all.
  // Callback form (createTicket): run it against mockDb.
  $transaction: vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: typeof mockDb) => unknown)(mockDb)
    }
    if (Array.isArray(arg)) return Promise.all(arg)
    return arg
  }),
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/security")>()
  return { ...actual, logAudit: mockLogAudit }
})

import type { AdminSession } from "@sendcms/auth"
import {
  adminReply,
  assignTicket,
  createTicket,
  getMyTicket,
  getTicket,
  listMyTickets,
  listTickets,
  replyToTicket,
  setTicketStatus,
} from "@sendcms/support"

const customerId = "customer-1"
const otherCustomerId = "customer-2"
const adminId = "admin-1"

function makeActor(
  overrides: Partial<AdminSession["user"]> = {}
): AdminSession {
  return {
    user: {
      id: adminId,
      name: "Admin",
      email: "admin@example.com",
      image: null,
      platformRole: "PLATFORM_USER",
      status: "ACTIVE",
      adminRole: null,
      emailVerified: true,
      ...overrides,
    },
    session: {
      id: "sess-1",
      userId: adminId,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    },
  }
}

const ownerActor = () =>
  makeActor({ id: "owner-1", platformRole: "PLATFORM_OWNER" })
const supportActor = () => makeActor({ adminRole: "SUPPORT" })
const plainUserActor = () => makeActor()

function makeUserRef(id: string) {
  return { id, name: `User ${id}`, email: `${id}@example.com` }
}

function makeTicketRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-11-22T10:00:00Z")
  return {
    id: "ticket-1",
    userId: customerId,
    user: makeUserRef(customerId),
    subject: "Cannot sign in",
    status: "OPEN",
    priority: "NORMAL",
    assignedToId: null,
    assignedTo: null,
    createdAt: now,
    updatedAt: now,
    _count: { messages: 1 },
    messages: [
      {
        id: "msg-1",
        authorId: customerId,
        author: makeUserRef(customerId),
        body: "I cannot sign in since yesterday.",
        createdAt: now,
      },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("createTicket", () => {
  it("creates the ticket and its first message in one transaction, then audits", async () => {
    const ticketRow = {
      id: "ticket-1",
      subject: "Cannot sign in",
      status: "OPEN",
      priority: "NORMAL",
      createdAt: new Date("2026-11-22T10:00:00Z"),
      updatedAt: new Date("2026-11-22T10:00:00Z"),
    }
    const messageRow = {
      id: "msg-1",
      authorId: customerId,
      body: "I cannot sign in since yesterday.",
      createdAt: new Date("2026-11-22T10:00:00Z"),
    }
    mockDb.supportTicket.create.mockResolvedValue(ticketRow)
    mockDb.ticketMessage.create.mockResolvedValue(messageRow)
    mockDb.user.findUnique.mockResolvedValue({
      ...makeUserRef(customerId),
      status: "ACTIVE",
    })

    const created = await createTicket(customerId, {
      subject: "Cannot sign in",
      body: "I cannot sign in since yesterday.",
      priority: "NORMAL",
    })

    expect(mockDb.$transaction).toHaveBeenCalledTimes(1)
    expect(typeof mockDb.$transaction.mock.calls[0][0]).toBe("function")
    expect(created.id).toBe("ticket-1")
    expect(created.messageCount).toBe(1)
    expect(created.messages[0].body).toBe("I cannot sign in since yesterday.")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CREATE",
        resourceType: "SUPPORT_TICKET",
        resourceId: "ticket-1",
        detail: expect.objectContaining({ event: "ticket-created" }),
      })
    )
  })

  it("refuses a ticket from a suspended account (403, no transaction)", async () => {
    mockDb.user.findUnique.mockResolvedValue({
      ...makeUserRef(customerId),
      status: "SUSPENDED",
    })
    await expect(
      createTicket(customerId, {
        subject: "Cannot sign in",
        body: "I cannot sign in since yesterday.",
        priority: "NORMAL",
      })
    ).rejects.toMatchObject({
      status: 403,
      message: "A suspended account cannot open a support ticket.",
    })
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  // SRC-238: the user lookup is an existence guard BEFORE the
  // transaction — a nonexistent user is a 404, never a raw FK 500
  // from the ticket create inside the transaction.
  it("404s for a nonexistent user (no transaction)", async () => {
    mockDb.user.findUnique.mockResolvedValue(null)
    await expect(
      createTicket("ghost-user", {
        subject: "Cannot sign in",
        body: "Cannot sign in.",
        priority: "NORMAL",
      })
    ).rejects.toMatchObject({ status: 404 })
    expect(mockDb.$transaction).not.toHaveBeenCalled()
    expect(mockDb.supportTicket.create).not.toHaveBeenCalled()
  })
})

describe("ownership", () => {
  it("user A cannot read user B's ticket (404, never 403)", async () => {
    mockDb.supportTicket.findUnique.mockResolvedValue(
      makeTicketRow({ userId: otherCustomerId })
    )
    await expect(getMyTicket(customerId, "ticket-1")).rejects.toMatchObject({
      status: 404,
    })
    expect(mockLogAudit).not.toHaveBeenCalled()
  })

  it("user A cannot reply to user B's ticket (404)", async () => {
    mockDb.supportTicket.findUnique.mockResolvedValue(
      makeTicketRow({ userId: otherCustomerId })
    )
    await expect(
      replyToTicket(customerId, "ticket-1", { body: "hello" })
    ).rejects.toMatchObject({ status: 404 })
    expect(mockDb.ticketMessage.create).not.toHaveBeenCalled()
  })

  it("listMyTickets only ever queries the caller's own tickets", async () => {
    mockDb.supportTicket.count.mockResolvedValue(0)
    mockDb.supportTicket.findMany.mockResolvedValue([])
    await listMyTickets(customerId, { page: 1, perPage: 20 })
    expect(mockDb.supportTicket.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: customerId } })
    )
    expect(mockDb.supportTicket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: customerId } })
    )
  })
})

describe("replyToTicket", () => {
  it("replying to a RESOLVED ticket reopens it to OPEN", async () => {
    const resolved = makeTicketRow({ status: "RESOLVED" })
    mockDb.supportTicket.findUnique.mockResolvedValue(resolved)
    mockDb.ticketMessage.create.mockResolvedValue({
      id: "msg-2",
      authorId: customerId,
      body: "Still broken.",
      createdAt: new Date("2026-11-22T11:00:00Z"),
    })
    mockDb.supportTicket.update.mockResolvedValue(
      // DB-046: the update include returns the newest 100 first — the
      // mock mirrors the real query (newest first), the service
      // reverses to display order.
      makeTicketRow({
        status: "OPEN",
        _count: { messages: 2 },
        messages: [
          {
            id: "msg-2",
            authorId: customerId,
            author: makeUserRef(customerId),
            body: "Still broken.",
            createdAt: new Date("2026-11-22T11:00:00Z"),
          },
          ...resolved.messages,
        ],
      })
    )

    const updated = await replyToTicket(customerId, "ticket-1", {
      body: "Still broken.",
    })
    expect(updated.status).toBe("OPEN")
    expect(updated.messageCount).toBe(2)
    expect(updated.hasMoreMessages).toBe(false)
    expect(updated.messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"])
    expect(mockDb.supportTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "OPEN" } })
    )
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          event: "ticket-replied",
          by: "customer",
          reopened: true,
        }),
      })
    )
  })

  it("replying to a CLOSED ticket is refused (409)", async () => {
    mockDb.supportTicket.findUnique.mockResolvedValue(
      makeTicketRow({ status: "CLOSED" })
    )
    await expect(
      replyToTicket(customerId, "ticket-1", { body: "hello again" })
    ).rejects.toMatchObject({ status: 409 })
    expect(mockDb.ticketMessage.create).not.toHaveBeenCalled()
    expect(mockLogAudit).not.toHaveBeenCalled()
  })
})

describe("setTicketStatus", () => {
  it("rejects transitions outside the status machine (409)", async () => {
    mockDb.supportTicket.findUnique.mockResolvedValue(
      makeTicketRow({ status: "CLOSED" })
    )
    await expect(
      setTicketStatus(ownerActor(), "ticket-1", {
        status: "OPEN",
        reason: "reopen it",
      })
    ).rejects.toMatchObject({ status: 409 })
    expect(mockDb.supportTicket.update).not.toHaveBeenCalled()
  })

  it("rejects RESOLVED → IN_PROGRESS (409) — resolve only reopens to OPEN", async () => {
    mockDb.supportTicket.findUnique.mockResolvedValue(
      makeTicketRow({ status: "RESOLVED" })
    )
    await expect(
      setTicketStatus(ownerActor(), "ticket-1", {
        status: "IN_PROGRESS",
        reason: "keep working",
      })
    ).rejects.toMatchObject({ status: 409 })
  })

  it("moves OPEN → IN_PROGRESS and audits with the reason", async () => {
    mockDb.supportTicket.findUnique.mockResolvedValue(makeTicketRow())
    mockDb.supportTicket.update.mockResolvedValue(
      makeTicketRow({ status: "IN_PROGRESS" })
    )
    const updated = await setTicketStatus(ownerActor(), "ticket-1", {
      status: "IN_PROGRESS",
      reason: "Looking into it.",
    })
    expect(updated.status).toBe("IN_PROGRESS")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          event: "ticket-status-changed",
          reason: "Looking into it.",
          oldStatus: "OPEN",
          newStatus: "IN_PROGRESS",
        }),
      })
    )
  })
})

describe("assignTicket", () => {
  it("refuses a non-staff assignee (422)", async () => {
    mockDb.supportTicket.findUnique.mockResolvedValue(makeTicketRow())
    mockDb.user.findUnique.mockResolvedValue({
      id: "user-9",
      platformRole: "PLATFORM_USER",
      adminRole: null,
    })
    await expect(
      assignTicket(ownerActor(), "ticket-1", {
        assignedToId: "user-9",
        reason: "Take this one.",
      })
    ).rejects.toMatchObject({ status: 422 })
    expect(mockDb.supportTicket.update).not.toHaveBeenCalled()
  })

  it("refuses an unknown assignee (404)", async () => {
    mockDb.supportTicket.findUnique.mockResolvedValue(makeTicketRow())
    mockDb.user.findUnique.mockResolvedValue(null)
    await expect(
      assignTicket(ownerActor(), "ticket-1", {
        assignedToId: "ghost",
        reason: "Take this one.",
      })
    ).rejects.toMatchObject({ status: 404 })
  })

  it("assigns to a staff admin-role holder and audits old/new assignee", async () => {
    mockDb.supportTicket.findUnique.mockResolvedValue(makeTicketRow())
    mockDb.user.findUnique.mockResolvedValue({
      id: "staff-1",
      platformRole: "PLATFORM_USER",
      adminRole: "SUPPORT",
    })
    mockDb.supportTicket.update.mockResolvedValue(
      makeTicketRow({
        assignedToId: "staff-1",
        assignedTo: makeUserRef("staff-1"),
      })
    )
    const updated = await assignTicket(ownerActor(), "ticket-1", {
      assignedToId: "staff-1",
      reason: "Support queue.",
    })
    expect(updated.assignedToId).toBe("staff-1")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ASSIGN",
        detail: expect.objectContaining({
          event: "ticket-assigned",
          oldAssigneeId: null,
          newAssigneeId: "staff-1",
        }),
      })
    )
  })
})

describe("admin reads and the SUPPORT role", () => {
  it("a plain signed-in user cannot list tickets (403)", async () => {
    await expect(
      listTickets(plainUserActor(), { page: 1, perPage: 20 })
    ).rejects.toMatchObject({ status: 403 })
    expect(mockDb.supportTicket.findMany).not.toHaveBeenCalled()
  })

  it("SUPPORT staff can read a ticket and reply to it", async () => {
    mockDb.supportTicket.findUnique.mockResolvedValue(makeTicketRow())
    const ticket = await getTicket(supportActor(), "ticket-1")
    expect(ticket.id).toBe("ticket-1")

    mockDb.ticketMessage.create.mockResolvedValue({
      id: "msg-2",
      authorId: adminId,
      body: "On it.",
      createdAt: new Date("2026-11-22T11:00:00Z"),
    })
    mockDb.supportTicket.update.mockResolvedValue(
      makeTicketRow({ status: "IN_PROGRESS" })
    )
    const updated = await adminReply(supportActor(), "ticket-1", {
      body: "On it.",
    })
    expect(updated.status).toBe("IN_PROGRESS")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          event: "ticket-replied",
          by: "admin",
        }),
      })
    )
  })

  it("SUPPORT staff can change a ticket's status", async () => {
    mockDb.supportTicket.findUnique.mockResolvedValue(makeTicketRow())
    mockDb.supportTicket.update.mockResolvedValue(
      makeTicketRow({ status: "RESOLVED" })
    )
    const updated = await setTicketStatus(supportActor(), "ticket-1", {
      status: "RESOLVED",
      reason: "Fixed.",
    })
    expect(updated.status).toBe("RESOLVED")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          event: "ticket-status-changed",
          reason: "Fixed.",
          oldStatus: "OPEN",
          newStatus: "RESOLVED",
        }),
      })
    )
  })

  it("SUPPORT staff can assign a ticket", async () => {
    mockDb.supportTicket.findUnique.mockResolvedValue(makeTicketRow())
    mockDb.user.findUnique.mockResolvedValue({
      id: "staff-1",
      platformRole: "PLATFORM_USER",
      adminRole: "SUPPORT",
    })
    mockDb.supportTicket.update.mockResolvedValue(
      makeTicketRow({
        assignedToId: "staff-1",
        assignedTo: makeUserRef("staff-1"),
      })
    )
    const updated = await assignTicket(supportActor(), "ticket-1", {
      assignedToId: "staff-1",
      reason: "Take this one.",
    })
    expect(updated.assignedToId).toBe("staff-1")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ASSIGN",
        detail: expect.objectContaining({ event: "ticket-assigned" }),
      })
    )
  })

  it("a plain signed-in user cannot reply to a ticket (403)", async () => {
    await expect(
      adminReply(plainUserActor(), "ticket-1", { body: "Hello." })
    ).rejects.toMatchObject({ status: 403 })
    expect(mockDb.ticketMessage.create).not.toHaveBeenCalled()
  })

  it("an admin reply moves the ticket to IN_PROGRESS and audits it", async () => {
    mockDb.supportTicket.findUnique.mockResolvedValue(makeTicketRow())
    mockDb.ticketMessage.create.mockResolvedValue({
      id: "msg-2",
      authorId: adminId,
      body: "Looking into it.",
      createdAt: new Date("2026-11-22T11:00:00Z"),
    })
    mockDb.supportTicket.update.mockResolvedValue(
      makeTicketRow({ status: "IN_PROGRESS" })
    )
    const updated = await adminReply(ownerActor(), "ticket-1", {
      body: "Looking into it.",
    })
    expect(updated.status).toBe("IN_PROGRESS")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          event: "ticket-replied",
          by: "admin",
        }),
      })
    )
  })

  it("an admin reply to a CLOSED ticket is refused (409)", async () => {
    mockDb.supportTicket.findUnique.mockResolvedValue(
      makeTicketRow({ status: "CLOSED" })
    )
    await expect(
      adminReply(ownerActor(), "ticket-1", { body: "Late reply." })
    ).rejects.toMatchObject({ status: 409 })
  })
})
