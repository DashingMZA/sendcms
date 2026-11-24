// Admin user-management service gates (Phase 3) with a mocked Prisma
// client. No test hits the real DB.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockLogAudit = vi.hoisted(() => vi.fn(async () => {}))

const mockDb = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    // DB-005: erasure must never hard-delete the user row — the spy
    // in the erasure test below proves executeErasure never calls this.
    delete: vi.fn(),
  },
  form: { findMany: vi.fn(), deleteMany: vi.fn() },
  domain: { findMany: vi.fn(), deleteMany: vi.fn() },
  submission: {
    groupBy: vi.fn(),
    count: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  apiKey: { findMany: vi.fn(), updateMany: vi.fn() },
  session: { deleteMany: vi.fn() },
  account: { deleteMany: vi.fn() },
  userAiKey: { deleteMany: vi.fn() },
  userAiSettings: { deleteMany: vi.fn() },
  mcpUserSettings: { deleteMany: vi.fn() },
  featureFlagOverride: { deleteMany: vi.fn() },
  entitlementOverride: { deleteMany: vi.fn() },
  // SRC-213: erasure deletes the outbox rows for the user and the
  // auth verification rows for the old email.
  emailJob: { deleteMany: vi.fn() },
  verification: { deleteMany: vi.fn() },
  adminNote: {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    deleteMany: vi.fn(),
  },
  auditLog: { findMany: vi.fn(), create: vi.fn() },
  // Phase 7: requestDeletion checks for an open request, then creates
  // the DeletionRequest row inside the same transaction.
  deletionRequest: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  // Phase 9: the gated actions (disable, role change) call
  // requireStepUp, which reads the latest unexpired verification.
  // These tests run as a verified admin.
  stepUpVerification: {
    findFirst: vi.fn(async () => ({
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    })),
  },
  // DB-051: setAdminRole reads the previous role under a row lock.
  $queryRaw: vi.fn(async (): Promise<{ adminRole: string | null }[]> => [
    { adminRole: null },
  ]),
  // Array form (suspend/disable run update + session wipe together):
  // the array already holds the mock calls' promises, so await them all.
  // Callback form (like rotateApiKeyForUser): run it against mockDb.
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

import { executeErasure } from "@sendcms/platform-ops"
import type { AdminSession } from "@sendcms/auth"
import {
  addAdminNote,
  disableUser,
  exportUserData,
  getUserDetail,
  getUserSubmission,
  listAdminNotes,
  listUserSubmissions,
  listUsers,
  reactivateUser,
  requestDeletion,
  requireAdmin,
  requireEmailVerification,
  restoreUser,
  revokeUserApiKeys,
  revokeUserSessions,
  setAdminRole,
  suspendUser,
  triggerPasswordReset,
} from "@sendcms/admin-users"
import { SuspendUserSchema } from "@sendcms/admin-users/validators"
import { ApiError } from "@sendcms/api-client"

const userId = "user-1"
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
const superAdminActor = () => makeActor({ adminRole: "SUPER_ADMIN" })
const managerActor = () => makeActor({ adminRole: "MANAGER" })
const supportActor = () => makeActor({ adminRole: "SUPPORT" })
const plainUserActor = () => makeActor()

function makeTargetUser(overrides: Record<string, unknown> = {}) {
  return {
    id: userId,
    platformRole: "PLATFORM_USER",
    status: "ACTIVE",
    adminRole: null,
    email: "customer@example.com",
    emailVerified: true,
    ...overrides,
  }
}

function makeUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: userId,
    name: "Customer",
    email: "customer@example.com",
    emailVerified: true,
    platformRole: "PLATFORM_USER",
    adminRole: null,
    status: "ACTIVE",
    statusReason: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    deletionRequestedAt: null,
    _count: { forms: 2, domains: 1, apiKeys: 1 },
    ...overrides,
  }
}

function makeSender() {
  return {
    sendVerificationEmail: vi.fn(async () => {}),
    sendPasswordReset: vi.fn(async () => {}),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.user.findUnique.mockResolvedValue(makeTargetUser())
  mockDb.form.findMany.mockResolvedValue([])
  mockDb.submission.groupBy.mockResolvedValue([])
})

describe("requireAdmin", () => {
  it("grants the owner, staff roles by capability, and nobody else", () => {
    expect(() => requireAdmin(ownerActor(), "MANAGE_USERS")).not.toThrow()
    expect(() => requireAdmin(superAdminActor(), "MANAGE_USERS")).not.toThrow()
    expect(() => requireAdmin(managerActor(), "MANAGE_USERS")).not.toThrow()
    expect(() => requireAdmin(supportActor(), "VIEW_USERS")).not.toThrow()
    expect(() => requireAdmin(supportActor(), "MANAGE_USERS")).toThrowError(
      ApiError
    )
    expect(() => requireAdmin(plainUserActor(), "VIEW_USERS")).toThrowError(
      ApiError
    )
    expect(() =>
      requireAdmin(supportActor(), "VIEW_SENSITIVE_SUBMISSIONS")
    ).not.toThrow()
    // MANAGER holds VIEW_SENSITIVE_SUBMISSIONS (support work) but cannot
    // manage plans, AI, or MCP.
    expect(() =>
      requireAdmin(managerActor(), "VIEW_SENSITIVE_SUBMISSIONS")
    ).not.toThrow()
    expect(() => requireAdmin(managerActor(), "MANAGE_PLANS")).toThrowError(
      ApiError
    )
  })
})

describe("listUsers", () => {
  it("searches name OR email (case-insensitive) and filters + paginates", async () => {
    mockDb.user.count.mockResolvedValue(25)
    mockDb.user.findMany.mockResolvedValue([
      makeUserRow(),
      makeUserRow({ id: "user-2", email: "other@example.com" }),
    ])
    const result = await listUsers(ownerActor(), {
      q: "zaheer",
      status: "SUSPENDED",
      adminRole: "MANAGER",
      emailVerified: true,
      page: 2,
      perPage: 10,
      sort: "createdAt:desc",
    })
    expect(result.total).toBe(25)
    expect(result.totalPages).toBe(3)
    expect(result.page).toBe(2)
    expect(result.users).toHaveLength(2)
    expect(result.users[0].counts).toEqual({
      forms: 2,
      domains: 1,
      submissions: 0,
      apiKeys: 1,
    })
    const findManyArg = mockDb.user.findMany.mock.calls[0][0]
    expect(findManyArg.where.OR).toEqual([
      { name: { contains: "zaheer", mode: "insensitive" } },
      { email: { contains: "zaheer", mode: "insensitive" } },
    ])
    expect(findManyArg.where.status).toBe("SUSPENDED")
    expect(findManyArg.where.adminRole).toBe("MANAGER")
    expect(findManyArg.where.emailVerified).toBe(true)
    expect(findManyArg.skip).toBe(10)
    expect(findManyArg.take).toBe(10)
    // The select never asks for a password, token, or key hash.
    expect(JSON.stringify(findManyArg.select)).not.toMatch(
      /password|token|keyHash/i
    )
  })

  it("counts submissions per user without N+1", async () => {
    mockDb.user.count.mockResolvedValue(2)
    mockDb.user.findMany.mockResolvedValue([
      makeUserRow(),
      makeUserRow({ id: "user-2", email: "other@example.com" }),
    ])
    mockDb.form.findMany.mockResolvedValue([
      { id: "form-1", ownerId: "user-1" },
      { id: "form-2", ownerId: "user-2" },
    ])
    mockDb.submission.groupBy.mockResolvedValue([
      { formId: "form-1", _count: { _all: 3 } },
      { formId: "form-2", _count: { _all: 1 } },
    ])
    const result = await listUsers(ownerActor(), {
      page: 1,
      perPage: 20,
      sort: "createdAt:desc",
    })
    expect(result.users[0].counts.submissions).toBe(3)
    expect(result.users[1].counts.submissions).toBe(1)
    expect(mockDb.submission.groupBy).toHaveBeenCalledTimes(1)
  })

  it("403s for a plain user", async () => {
    await expect(
      listUsers(plainUserActor(), {
        page: 1,
        perPage: 20,
        sort: "createdAt:desc",
      })
    ).rejects.toThrowError(ApiError)
  })
})

describe("getUserDetail", () => {
  it("returns profile, counts, forms, domains, keys, notes, audit events", async () => {
    mockDb.user.findUnique.mockResolvedValue({
      ...makeUserRow(),
      locale: "ur",
      updatedAt: new Date("2026-11-20T00:00:00Z"),
      statusChangedAt: null,
    })
    mockDb.form.findMany.mockResolvedValue([
      {
        id: "form-1",
        name: "Contact us",
        aiEnabled: true,
        createdAt: new Date(),
      },
    ])
    mockDb.domain.findMany.mockResolvedValue([
      {
        id: "domain-1",
        domain: "example.com",
        status: "VERIFIED",
        createdAt: new Date(),
      },
    ])
    mockDb.apiKey.findMany.mockResolvedValue([
      {
        id: "key-1",
        prefix: "sk_live_aB3x",
        last4: "9f2k",
        scope: "FULL",
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date(),
      },
    ])
    mockDb.adminNote.findMany.mockResolvedValue([])
    mockDb.auditLog.findMany.mockResolvedValue([])
    const detail = await getUserDetail(supportActor(), userId)
    expect(detail.profile.locale).toBe("ur")
    expect(detail.counts.forms).toBe(2)
    expect(detail.forms).toHaveLength(1)
    expect(detail.domains).toHaveLength(1)
    expect(detail.apiKeys[0]).not.toHaveProperty("keyHash")
    const keySelect = mockDb.apiKey.findMany.mock.calls[0][0].select
    expect(keySelect).not.toHaveProperty("keyHash")
  })

  it("404s for an unknown user", async () => {
    mockDb.user.findUnique.mockResolvedValue(null)
    await expect(getUserDetail(ownerActor(), "nope")).rejects.toThrowError(
      "User not found"
    )
  })
})

describe("listUserSubmissions / getUserSubmission", () => {
  it("returns metadata only — never the submission data", async () => {
    mockDb.submission.count.mockResolvedValue(1)
    mockDb.submission.findMany.mockResolvedValue([
      {
        id: "sub-1",
        formId: "form-1",
        status: "NEW",
        createdAt: new Date(),
        originDomain: "example.com",
        form: { name: "Contact us" },
      },
    ])
    const result = await listUserSubmissions(supportActor(), userId, {
      page: 1,
      perPage: 20,
    })
    expect(result.submissions).toHaveLength(1)
    expect(result.submissions[0]).toEqual({
      id: "sub-1",
      formId: "form-1",
      formName: "Contact us",
      status: "NEW",
      createdAt: expect.any(Date),
      originDomain: "example.com",
    })
    expect(result.submissions[0]).not.toHaveProperty("data")
    const select = mockDb.submission.findMany.mock.calls[0][0].select
    expect(select).not.toHaveProperty("data")
  })

  it("requires VIEW_SENSITIVE_SUBMISSIONS and logs the access", async () => {
    const submission = {
      id: "sub-1",
      data: { email: "visitor@example.com", message: "hi" },
      form: { id: "form-1", name: "Contact us" },
    }
    mockDb.submission.findFirst.mockResolvedValue(submission)
    const found = await getUserSubmission(supportActor(), userId, "sub-1")
    expect(found.data).toEqual({ email: "visitor@example.com", message: "hi" })
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE",
        resourceType: "SUBMISSION",
        resourceId: "sub-1",
        detail: expect.objectContaining({
          event: "sensitive-submission-access",
          userId,
        }),
      })
    )
  })

  it("403s without VIEW_SENSITIVE_SUBMISSIONS and 404s when not owned", async () => {
    await expect(
      getUserSubmission(plainUserActor(), userId, "sub-1")
    ).rejects.toThrowError(ApiError)
    expect(mockDb.submission.findFirst).not.toHaveBeenCalled()
    mockDb.submission.findFirst.mockResolvedValue(null)
    await expect(
      getUserSubmission(supportActor(), userId, "sub-1")
    ).rejects.toThrowError("Submission not found")
    expect(mockLogAudit).not.toHaveBeenCalled()
  })
})

describe("suspendUser / reactivateUser", () => {
  it("requires a reason (validator + service)", async () => {
    expect(SuspendUserSchema.safeParse({}).success).toBe(false)
    expect(SuspendUserSchema.safeParse({ reason: "  " }).success).toBe(false)
    expect(SuspendUserSchema.safeParse({ reason: "Spam" }).success).toBe(true)
    await expect(
      suspendUser(ownerActor(), userId, { reason: "  " })
    ).rejects.toThrowError("Reason is required")
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it("sets SUSPENDED, revokes sessions, and audits", async () => {
    const now = new Date()
    mockDb.user.update.mockResolvedValue({
      id: userId,
      status: "SUSPENDED",
      statusReason: "Spam",
      statusChangedAt: now,
    })
    mockDb.session.deleteMany.mockResolvedValue({ count: 2 })
    const updated = await suspendUser(ownerActor(), userId, {
      reason: "Spam",
    })
    expect(updated.status).toBe("SUSPENDED")
    expect(mockDb.$transaction).toHaveBeenCalled()
    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: userId },
        data: expect.objectContaining({
          status: "SUSPENDED",
          statusReason: "Spam",
        }),
      })
    )
    expect(mockDb.session.deleteMany).toHaveBeenCalledWith({
      where: { userId },
    })
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SUSPEND",
        resourceType: "USER",
        resourceId: userId,
        detail: expect.objectContaining({
          event: "user-suspended",
          reason: "Spam",
        }),
      })
    )
  })

  it("409s when already suspended or disabled", async () => {
    mockDb.user.findUnique.mockResolvedValue(
      makeTargetUser({ status: "SUSPENDED" })
    )
    await expect(
      suspendUser(ownerActor(), userId, { reason: "x" })
    ).rejects.toThrowError("already suspended")
    mockDb.user.findUnique.mockResolvedValue(
      makeTargetUser({ status: "DISABLED" })
    )
    await expect(
      suspendUser(ownerActor(), userId, { reason: "x" })
    ).rejects.toThrowError("disabled")
  })

  it("forbids the owner and self-suspension", async () => {
    mockDb.user.findUnique.mockResolvedValue(
      makeTargetUser({ platformRole: "PLATFORM_OWNER" })
    )
    await expect(
      suspendUser(ownerActor(), userId, { reason: "x" })
    ).rejects.toThrowError("platform owner")
    mockDb.user.findUnique.mockResolvedValue(makeTargetUser())
    // The actor must hold MANAGE_USERS for the self-guard to be reached
    // (a plain user 403s at requireAdmin first).
    await expect(
      suspendUser(makeActor({ id: userId, adminRole: "SUPER_ADMIN" }), userId, {
        reason: "x",
      })
    ).rejects.toThrowError("your own account")
  })

  it("reactivates only from SUSPENDED", async () => {
    mockDb.user.findUnique.mockResolvedValue(
      makeTargetUser({ status: "SUSPENDED" })
    )
    mockDb.user.update.mockResolvedValue({
      id: userId,
      status: "ACTIVE",
      statusReason: null,
      statusChangedAt: new Date(),
    })
    const updated = await reactivateUser(superAdminActor(), userId, {})
    expect(updated.status).toBe("ACTIVE")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "REACTIVATE",
        detail: expect.objectContaining({ event: "user-reactivated" }),
      })
    )
    mockDb.user.findUnique.mockResolvedValue(makeTargetUser())
    await expect(reactivateUser(ownerActor(), userId, {})).rejects.toThrowError(
      "Only a suspended user"
    )
    mockDb.user.findUnique.mockResolvedValue(
      makeTargetUser({ status: "DISABLED" })
    )
    await expect(reactivateUser(ownerActor(), userId, {})).rejects.toThrowError(
      "Only a suspended user"
    )
  })
})

describe("disableUser / restoreUser", () => {
  it("disables from ACTIVE, revokes sessions, and audits", async () => {
    mockDb.user.update.mockResolvedValue({
      id: userId,
      status: "DISABLED",
      statusReason: "Abuse",
      statusChangedAt: new Date(),
    })
    mockDb.session.deleteMany.mockResolvedValue({ count: 1 })
    const updated = await disableUser(ownerActor(), userId, {
      reason: "Abuse",
    })
    expect(updated.status).toBe("DISABLED")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE",
        detail: expect.objectContaining({ event: "user-disabled" }),
      })
    )
  })

  it("409s when suspended or already disabled, and forbids owner/self", async () => {
    mockDb.user.findUnique.mockResolvedValue(
      makeTargetUser({ status: "SUSPENDED" })
    )
    await expect(
      disableUser(ownerActor(), userId, { reason: "x" })
    ).rejects.toThrowError("Reactivate")
    mockDb.user.findUnique.mockResolvedValue(
      makeTargetUser({ status: "DISABLED" })
    )
    await expect(
      disableUser(ownerActor(), userId, { reason: "x" })
    ).rejects.toThrowError("already disabled")
    mockDb.user.findUnique.mockResolvedValue(
      makeTargetUser({ platformRole: "PLATFORM_OWNER" })
    )
    await expect(
      disableUser(ownerActor(), userId, { reason: "x" })
    ).rejects.toThrowError("platform owner")
  })

  it("restores only from DISABLED", async () => {
    mockDb.user.findUnique.mockResolvedValue(
      makeTargetUser({ status: "DISABLED" })
    )
    mockDb.user.update.mockResolvedValue({
      id: userId,
      status: "ACTIVE",
      statusReason: null,
      statusChangedAt: new Date(),
    })
    const updated = await restoreUser(ownerActor(), userId, {})
    expect(updated.status).toBe("ACTIVE")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ event: "user-restored" }),
      })
    )
    mockDb.user.findUnique.mockResolvedValue(makeTargetUser())
    await expect(restoreUser(ownerActor(), userId, {})).rejects.toThrowError(
      "Only a disabled user"
    )
  })
})

describe("setAdminRole", () => {
  it("forbids MANAGER, self-changes, and the owner", async () => {
    await expect(
      setAdminRole(managerActor(), userId, { adminRole: "SUPPORT" })
    ).rejects.toThrowError("Only the platform owner and Super Admin")
    await expect(
      setAdminRole(superAdminActor(), adminId, { adminRole: "SUPPORT" })
    ).rejects.toThrowError("your own account")
    mockDb.user.findUnique.mockResolvedValue(
      makeTargetUser({ platformRole: "PLATFORM_OWNER" })
    )
    await expect(
      setAdminRole(ownerActor(), userId, { adminRole: "MANAGER" })
    ).rejects.toThrowError("platform owner")
  })

  it("sets the role and audits from/to (null removes it)", async () => {
    mockDb.user.update.mockResolvedValue({ id: userId, adminRole: "MANAGER" })
    const result = await setAdminRole(superAdminActor(), userId, {
      adminRole: "MANAGER",
    })
    expect(result).toEqual({
      id: userId,
      adminRole: "MANAGER",
      previousAdminRole: null,
    })
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          event: "admin-role-changed",
          from: null,
          to: "MANAGER",
        }),
      })
    )
    mockDb.user.findUnique.mockResolvedValue(
      makeTargetUser({ adminRole: "MANAGER" })
    )
    mockDb.user.update.mockResolvedValue({ id: userId, adminRole: null })
    // DB-051: the locked before-read returns the current role.
    mockDb.$queryRaw.mockResolvedValue([{ adminRole: "MANAGER" }])
    const removed = await setAdminRole(ownerActor(), userId, {
      adminRole: null,
    })
    expect(removed.adminRole).toBeNull()
    expect(removed.previousAdminRole).toBe("MANAGER")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          event: "admin-role-changed",
          from: "MANAGER",
          to: null,
        }),
      })
    )
  })
})

describe("revokeUserApiKeys / revokeUserSessions", () => {
  it("revokes all active keys and audits the count", async () => {
    mockDb.apiKey.updateMany.mockResolvedValue({ count: 3 })
    const result = await revokeUserApiKeys(ownerActor(), userId)
    expect(result).toEqual({ count: 3 })
    expect(mockDb.apiKey.updateMany).toHaveBeenCalledWith({
      where: { userId, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    })
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          event: "api-keys-revoked",
          count: 3,
        }),
      })
    )
  })

  it("deletes sessions, forbids self-revocation", async () => {
    mockDb.session.deleteMany.mockResolvedValue({ count: 2 })
    const result = await revokeUserSessions(superAdminActor(), userId)
    expect(result).toEqual({ count: 2 })
    expect(mockDb.session.deleteMany).toHaveBeenCalledWith({
      where: { userId },
    })
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ event: "sessions-revoked" }),
      })
    )
    await expect(
      revokeUserSessions(
        makeActor({ id: userId, adminRole: "SUPER_ADMIN" }),
        userId
      )
    ).rejects.toThrowError("your own account")
  })
})

describe("requireEmailVerification / triggerPasswordReset", () => {
  it("sends the verification email, then flips the flag, then audits", async () => {
    const sender = makeSender()
    mockDb.user.update.mockResolvedValue({ id: userId, emailVerified: false })
    const updated = await requireEmailVerification(ownerActor(), userId, sender)
    expect(updated.emailVerified).toBe(false)
    expect(sender.sendVerificationEmail).toHaveBeenCalledWith(
      "customer@example.com"
    )
    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: userId },
        data: { emailVerified: false },
      })
    )
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          event: "email-verification-required",
        }),
      })
    )
  })

  it("changes nothing when the send fails", async () => {
    const sender = makeSender()
    sender.sendVerificationEmail.mockRejectedValue(new Error("SMTP down"))
    await expect(
      requireEmailVerification(ownerActor(), userId, sender)
    ).rejects.toThrowError("SMTP down")
    expect(mockDb.user.update).not.toHaveBeenCalled()
    expect(mockLogAudit).not.toHaveBeenCalled()
  })

  it("sends the password reset and audits", async () => {
    const sender = makeSender()
    const result = await triggerPasswordReset(ownerActor(), userId, sender)
    expect(result).toEqual({ id: userId, email: "customer@example.com" })
    expect(sender.sendPasswordReset).toHaveBeenCalledWith(
      "customer@example.com"
    )
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          event: "password-reset-triggered",
        }),
      })
    )
  })
})

describe("addAdminNote / listAdminNotes", () => {
  it("creates a note with the actor as author", async () => {
    const note = {
      id: "note-1",
      userId,
      adminId: adminId,
      body: "Called the customer.",
      createdAt: new Date(),
      updatedAt: new Date(),
      admin: { id: adminId, name: "Admin", email: "admin@example.com" },
    }
    mockDb.adminNote.create.mockResolvedValue(note)
    // superAdminActor's id is admin-1, matching the note's adminId.
    const created = await addAdminNote(superAdminActor(), userId, {
      body: "Called the customer.",
    })
    expect(created.adminId).toBe(adminId)
    expect(mockDb.adminNote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId,
          adminId,
          body: "Called the customer.",
        }),
      })
    )
  })

  it("paginates notes with the admin name", async () => {
    mockDb.adminNote.count.mockResolvedValue(21)
    mockDb.adminNote.findMany.mockResolvedValue([])
    const result = await listAdminNotes(ownerActor(), userId, {
      page: 2,
      perPage: 20,
    })
    expect(result.total).toBe(21)
    expect(result.totalPages).toBe(2)
    expect(mockDb.adminNote.findMany.mock.calls[0][0].skip).toBe(20)
  })
})

describe("exportUserData", () => {
  it("exports safe fields only — no keyHash, password, or submission data", async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: userId,
      name: "Customer",
      email: "customer@example.com",
      emailVerified: true,
      platformRole: "PLATFORM_USER",
      adminRole: null,
      status: "ACTIVE",
      locale: "ur",
      createdAt: new Date(),
    })
    mockDb.domain.findMany.mockResolvedValue([])
    mockDb.form.findMany.mockResolvedValue([
      {
        id: "form-1",
        name: "Contact us",
        fields: [{ name: "email", type: "EMAIL", required: true }],
      },
    ])
    mockDb.submission.findMany.mockResolvedValue([
      {
        id: "sub-1",
        formId: "form-1",
        status: "NEW",
        createdAt: new Date(),
        originDomain: "example.com",
        form: { name: "Contact us" },
      },
    ])
    mockDb.apiKey.findMany.mockResolvedValue([
      { prefix: "sk_live_aB3x", last4: "9f2k", scope: "FULL", revokedAt: null },
    ])
    mockDb.auditLog.findMany.mockResolvedValue([])
    const data = await exportUserData(supportActor(), userId)
    const serialized = JSON.stringify(data)
    expect(serialized).not.toMatch(/keyHash|password|token/i)
    expect(data.submissions.count).toBe(1)
    expect(data.submissions.items[0]).not.toHaveProperty("data")
    expect(data.forms[0].fields).toEqual([
      { name: "email", type: "EMAIL", required: true },
    ])
    const submissionSelect = mockDb.submission.findMany.mock.calls[0][0].select
    expect(submissionSelect).not.toHaveProperty("data")
    const keySelect = mockDb.apiKey.findMany.mock.calls[0][0].select
    expect(keySelect).not.toHaveProperty("keyHash")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ event: "user-data-exported" }),
      })
    )
  })
})

describe("requestDeletion", () => {
  it("records the request (no data deleted) and audits", async () => {
    mockDb.user.update.mockResolvedValue({
      id: userId,
      deletionRequestedAt: new Date(),
      deletionRequestReason: "Leaving",
    })
    mockDb.deletionRequest.create.mockResolvedValue({ id: "dr-1" })
    const updated = await requestDeletion(ownerActor(), userId, {
      reason: "Leaving",
    })
    expect(updated.deletionRequestReason).toBe("Leaving")
    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deletionRequestReason: "Leaving",
          deletionRequestedAt: expect.any(Date),
        }),
      })
    )
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          event: "deletion-requested",
          reason: "Leaving",
        }),
      })
    )
    await expect(
      requestDeletion(ownerActor(), userId, { reason: "  " })
    ).rejects.toThrowError("Reason is required")
  })
})

// ─── Erasure (DB-005 / SRC-213) ─────────────────────────────────────────
// Erasure is anonymization, never a hard user delete: the usage/AI/MCP/
// subscription rows survive ONLY because the user row stays (they are
// Cascade off User — owner decision 2026-11-24, DB-005). This test pins
// the service side of that decision, plus the SRC-213 outbox cleanup.
describe("executeErasure", () => {
  it("never calls db.user.delete, and removes outbox + verification rows", async () => {
    const oldEmail = "customer@example.com"
    mockDb.deletionRequest.findUnique.mockResolvedValue({
      id: "dr-1",
      userId,
      status: "APPROVED",
      reason: "GDPR erasure",
      user: {
        id: userId,
        name: "Customer",
        email: oldEmail,
        platformRole: "PLATFORM_USER",
        status: "ACTIVE",
        deletionCompletedAt: null,
      },
    })
    mockDb.user.update.mockResolvedValue({ id: userId })
    mockDb.form.findMany.mockResolvedValue([{ id: "form-1" }])
    for (const del of [
      mockDb.account.deleteMany,
      mockDb.session.deleteMany,
      mockDb.userAiKey.deleteMany,
      mockDb.userAiSettings.deleteMany,
      mockDb.mcpUserSettings.deleteMany,
      mockDb.featureFlagOverride.deleteMany,
      mockDb.entitlementOverride.deleteMany,
      mockDb.adminNote.deleteMany,
      mockDb.domain.deleteMany,
      mockDb.form.deleteMany,
      mockDb.emailJob.deleteMany,
      mockDb.verification.deleteMany,
    ]) {
      del.mockResolvedValue({ count: 0 })
    }
    mockDb.apiKey.updateMany.mockResolvedValue({ count: 0 })
    mockDb.deletionRequest.update.mockResolvedValue({
      id: "dr-1",
      status: "COMPLETED",
    })

    await executeErasure(ownerActor(), "dr-1", { reason: "GDPR erasure" })

    // DB-005: the user row is anonymized, never hard-deleted.
    expect(mockDb.user.delete).not.toHaveBeenCalled()
    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: userId },
        data: expect.objectContaining({
          email: expect.stringMatching(/^deleted-.*@deleted\.local$/),
          name: "Deleted user",
          status: "DISABLED",
        }),
      })
    )
    // SRC-213: outbox rows addressed to the user (or on their forms)
    // and auth verification rows for the old email are deleted.
    expect(mockDb.emailJob.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [{ to: oldEmail }, { formId: { in: ["form-1"] } }],
      },
    })
    expect(mockDb.verification.deleteMany).toHaveBeenCalledWith({
      where: { identifier: oldEmail },
    })
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ event: "account-erased" }),
      })
    )
  })
})
