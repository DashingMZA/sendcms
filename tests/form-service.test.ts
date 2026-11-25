// Form service gates (Phase 4) with a mocked Prisma client.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  form: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    // DSH-107: listFormsPageForUser pages through these.
    count: vi.fn(),
    findMany: vi.fn(),
  },
  domain: { findFirst: vi.fn(), findMany: vi.fn() },
  formDomain: { findUnique: vi.fn(), create: vi.fn() },
  formField: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  notificationSettings: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  verification: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  auditLog: { create: vi.fn() },
  // DB-029: createFormForUser takes a per-user advisory lock inside
  // its transaction (tx IS mockDb in this file's $transaction stub).
  $executeRaw: vi.fn(async () => 0),
  $transaction: vi.fn(),
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
// The plans module is mocked so the fail-closed limit check in
// createFormForUser does not run the real entitlement lookup against
// this file's partial Prisma mock (same pattern as billing.test.ts).
const mockCheckLimitStrict = vi.hoisted(() =>
  vi.fn(async () => ({ allowed: true, limit: null, used: 0, remaining: null }))
)
vi.mock("@sendcms/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/plans")>()
  return { ...actual, checkLimitStrict: mockCheckLimitStrict }
})

import {
  addFieldToForm,
  addNotificationEmailToForm,
  confirmNotificationEmail,
  createFormForUser,
  deleteFieldForUser,
  deleteFormForUser,
  deleteNotificationEmailForUser,
  getFormForUser,
  linkDomainToForm,
  listFormsPageForUser,
  resendNotificationConfirmation,
  updateFieldForUser,
  updateFormForUser,
  updateNotificationEmailForUser,
} from "@sendcms/forms"

import { ApiError } from "@sendcms/api-client"
import { Prisma } from "@sendcms/database"

function makeForm(overrides: Record<string, unknown> = {}) {
  return {
    id: "form-1",
    name: "Contact us",
    ownerId: "user-1",
    active: true,
    fields: [
      { name: "name", order: 0 },
      { name: "email", order: 1 },
      { name: "message", order: 2 },
    ],
    domainLinks: [],
    notificationSettings: [],
    _count: { submissions: 0 },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckLimitStrict.mockResolvedValue({
    allowed: true,
    limit: null,
    used: 0,
    remaining: null,
  })
  // The service uses the callback form of $transaction for field
  // reordering; the array form is kept for the callers that use it.
  mockDb.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: typeof mockDb) => Promise<unknown>)(mockDb)
    }
    return Promise.all(arg as Promise<unknown>[])
  })
  mockDb.domain.findMany.mockResolvedValue([{ domain: "example.com" }])
  mockDb.formField.update.mockImplementation(
    async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: args.where.id,
      ...args.data,
    })
  )
  mockDb.formField.delete.mockResolvedValue({ id: "field-1" })
  mockDb.form.findFirst.mockResolvedValue(makeForm())
  mockDb.form.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: "form-1",
      ...args.data,
      fields: [{ name: "name" }, { name: "email" }, { name: "message" }],
    })
  )
  mockDb.form.update.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      ...makeForm(),
      ...args.data,
    })
  )
  mockDb.formField.findUnique.mockResolvedValue(null)
  mockDb.formField.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: "field-1",
      ...args.data,
    })
  )
  mockDb.domain.findFirst.mockResolvedValue({
    id: "dom-1",
    domain: "example.com",
    status: "VERIFIED",
  })
  mockDb.formDomain.findUnique.mockResolvedValue(null)
  mockDb.formDomain.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: "link-1",
      ...args.data,
      domain: { id: "dom-1", domain: "example.com" },
    })
  )
  mockDb.notificationSettings.findUnique.mockResolvedValue(null)
  mockDb.notificationSettings.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: "notif-1",
      ...args.data,
    })
  )
  mockDb.notificationSettings.update.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: "notif-1",
      formId: "form-1",
      email: "owner@example.com",
      enabled: true,
      ...args.data,
    })
  )
  mockDb.notificationSettings.delete.mockResolvedValue({
    id: "notif-1",
  })
  mockDb.verification.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: "verif-1",
      ...args.data,
    })
  )
  mockDb.verification.findFirst.mockResolvedValue(null)
  mockDb.verification.findMany.mockResolvedValue([])
  mockDb.verification.delete.mockResolvedValue({ id: "verif-1" })
  mockDb.verification.deleteMany.mockResolvedValue({ count: 0 })
  mockDb.form.findUnique.mockResolvedValue({
    id: "form-1",
    ownerId: "user-1",
  })
  mockDb.auditLog.create.mockResolvedValue({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function expectApiError(promise: Promise<unknown>, status: number) {
  try {
    await promise
    throw new Error("expected an ApiError")
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(status)
  }
}

describe("createFormForUser", () => {
  it("creates the form with the 3 default fields", async () => {
    const created = await createFormForUser("user-1", {
      name: "Contact us",
      honeypotEnabled: true,
      turnstileEnabled: false,
    })
    expect(created.id).toBe("form-1")
    const createArg = mockDb.form.create.mock.calls[0][0] as {
      data: { fields: { create: { name: string }[] } }
    }
    expect(createArg.data.fields.create.map((f) => f.name)).toEqual([
      "name",
      "email",
      "message",
    ])
    expect(mockDb.auditLog.create).toHaveBeenCalled()
  })
})

// SDK-016: a form with Turnstile on and no server secret can never
// accept a submission — the service refuses to build one.
describe("Turnstile enable refusal (SDK-016)", () => {
  const originalSecret = process.env.TURNSTILE_SECRET_KEY
  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.TURNSTILE_SECRET_KEY
    } else {
      process.env.TURNSTILE_SECRET_KEY = originalSecret
    }
  })

  it("refuses to create a Turnstile form when the secret is unset", async () => {
    delete process.env.TURNSTILE_SECRET_KEY
    await expectApiError(
      createFormForUser("user-1", {
        name: "Contact us",
        honeypotEnabled: true,
        turnstileEnabled: true,
      }),
      422
    )
    expect(mockDb.form.create).not.toHaveBeenCalled()
  })

  it("creates a Turnstile form when the secret is set", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret"
    const created = await createFormForUser("user-1", {
      name: "Contact us",
      honeypotEnabled: true,
      turnstileEnabled: true,
    })
    expect(created.id).toBe("form-1")
    expect(mockDb.form.create).toHaveBeenCalled()
  })

  it("refuses to newly enable Turnstile on an existing form when the secret is unset", async () => {
    delete process.env.TURNSTILE_SECRET_KEY
    await expectApiError(
      updateFormForUser("user-1", "form-1", { turnstileEnabled: true }),
      422
    )
    expect(mockDb.form.update).not.toHaveBeenCalled()
  })

  it("lets an already-Turnstile form stay Turnstile when the secret is unset", async () => {
    delete process.env.TURNSTILE_SECRET_KEY
    mockDb.form.findFirst.mockResolvedValue(
      makeForm({ turnstileEnabled: true })
    )
    const updated = await updateFormForUser("user-1", "form-1", {
      name: "Renamed",
    })
    expect(updated.name).toBe("Renamed")
    expect(mockDb.form.update).toHaveBeenCalled()
  })
})

describe("updateFormForUser", () => {
  it("toggles the form inactive", async () => {
    const updated = await updateFormForUser("user-1", "form-1", {
      active: false,
    })
    expect(updated.active).toBe(false)
    expect(mockDb.form.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "form-1" } })
    )
  })

  it("passes the AI opt-in flag through to the update", async () => {
    await updateFormForUser("user-1", "form-1", { aiEnabled: true })
    expect(mockDb.form.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ aiEnabled: true }),
      })
    )
  })

  it("passes the digest preference through to the update (EML-093)", async () => {
    await updateFormForUser("user-1", "form-1", {
      digestEnabled: true,
      digestIntervalHours: 168,
    })
    expect(mockDb.form.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          digestEnabled: true,
          digestIntervalHours: 168,
        }),
      })
    )
  })

  it("throws 404 for a form owned by someone else", async () => {
    mockDb.form.findFirst.mockResolvedValue(null)
    await expectApiError(
      updateFormForUser("user-1", "form-1", { active: false }),
      404
    )
  })
})

describe("linkDomainToForm", () => {
  it("refuses a pending domain with 409", async () => {
    mockDb.domain.findFirst.mockResolvedValue({
      id: "dom-1",
      domain: "example.com",
      status: "PENDING",
    })
    await expectApiError(
      linkDomainToForm("user-1", "form-1", { domainId: "dom-1" }),
      409
    )
    expect(mockDb.formDomain.create).not.toHaveBeenCalled()
  })

  it("refuses a duplicate link with 409", async () => {
    mockDb.formDomain.findUnique.mockResolvedValue({ id: "link-1" })
    await expectApiError(
      linkDomainToForm("user-1", "form-1", { domainId: "dom-1" }),
      409
    )
  })

  it("refuses an unknown domain with 404", async () => {
    mockDb.domain.findFirst.mockResolvedValue(null)
    await expectApiError(
      linkDomainToForm("user-1", "form-1", { domainId: "dom-1" }),
      404
    )
  })

  it("creates the link for a verified domain", async () => {
    const link = await linkDomainToForm("user-1", "form-1", {
      domainId: "dom-1",
    })
    expect(link.id).toBe("link-1")
    expect(mockDb.formDomain.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { formId: "form-1", domainId: "dom-1" },
      })
    )
  })

  // DB-028: the pre-check is not enough — a concurrent duplicate
  // link surfaces as P2002, which is a 409, never a 500.
  it("maps a concurrent duplicate link (P2002) to 409, never 500", async () => {
    mockDb.formDomain.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "7",
      })
    )
    await expectApiError(
      linkDomainToForm("user-1", "form-1", { domainId: "dom-1" }),
      409
    )
  })
})

describe("addFieldToForm", () => {
  it("refuses a duplicate field key with 409", async () => {
    mockDb.formField.findUnique.mockResolvedValue({ id: "field-0" })
    await expectApiError(
      addFieldToForm("user-1", "form-1", {
        name: "email",
        label: "Email",
        type: "EMAIL",
        required: true,
      }),
      409
    )
  })

  it("defaults the order to max + 1", async () => {
    const field = await addFieldToForm("user-1", "form-1", {
      name: "topic",
      label: "Topic",
      type: "SELECT",
      required: false,
      options: ["General", "Support"],
    })
    expect(field.order).toBe(3)
    expect(mockDb.formField.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "topic", order: 3 }),
      })
    )
  })
})

describe("createFormForUser redirectUrl (SEC-210)", () => {
  const base = {
    name: "Contact us",
    honeypotEnabled: true,
    turnstileEnabled: false,
  } as const

  it("accepts an absolute redirect to the owner's verified domain", async () => {
    const created = await createFormForUser("user-1", {
      ...base,
      redirectUrl: "https://example.com/thanks",
    })
    expect(created.id).toBe("form-1")
    expect(mockDb.domain.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId: "user-1", status: "VERIFIED" },
      })
    )
  })

  it("refuses an absolute redirect to an unverified host with 400", async () => {
    await expectApiError(
      createFormForUser("user-1", {
        ...base,
        redirectUrl: "https://evil.example/thanks",
      }),
      400
    )
    expect(mockDb.form.create).not.toHaveBeenCalled()
  })

  it("accepts a relative redirect without a domain lookup", async () => {
    await createFormForUser("user-1", {
      ...base,
      redirectUrl: "/thanks",
    })
    expect(mockDb.domain.findMany).not.toHaveBeenCalled()
    expect(mockDb.form.create).toHaveBeenCalled()
  })
})

describe("updateFormForUser redirectUrl (SEC-210)", () => {
  function mockFormWithLink() {
    mockDb.form.findFirst.mockResolvedValue(
      makeForm({
        domainLinks: [{ domain: { domain: "example.com" } }],
      })
    )
  }

  it("accepts an absolute redirect to a linked domain", async () => {
    mockFormWithLink()
    const updated = await updateFormForUser("user-1", "form-1", {
      redirectUrl: "https://www.example.com/thanks",
    })
    expect(updated.redirectUrl).toBe("https://www.example.com/thanks")
  })

  it("refuses an absolute redirect to an unlinked host with 400", async () => {
    mockFormWithLink()
    await expectApiError(
      updateFormForUser("user-1", "form-1", {
        redirectUrl: "https://evil.example/thanks",
      }),
      400
    )
    expect(mockDb.form.update).not.toHaveBeenCalled()
  })

  it("accepts a relative redirect", async () => {
    mockFormWithLink()
    const updated = await updateFormForUser("user-1", "form-1", {
      redirectUrl: "/thanks",
    })
    expect(updated.redirectUrl).toBe("/thanks")
  })
})

function orderWrites() {
  return mockDb.formField.update.mock.calls
    .map((c) => c[0] as { where: { id: string }; data: { order?: number } })
    .filter((a) => typeof a.data.order === "number")
}

const ORDERED_FIELDS = [
  { id: "f-name", name: "name", order: 0 },
  { id: "f-email", name: "email", order: 1 },
  { id: "f-message", name: "message", order: 2 },
]

describe("updateFieldForUser order (DSH-105)", () => {
  beforeEach(() => {
    mockDb.form.findFirst.mockResolvedValue(
      makeForm({ fields: ORDERED_FIELDS })
    )
  })

  it("moving the last field to 0 re-sequences every order uniquely", async () => {
    const updated = await updateFieldForUser("user-1", "form-1", "f-message", {
      order: 0,
    })
    expect(updated.order).toBe(0)
    expect(orderWrites()).toEqual([
      { where: { id: "f-message" }, data: { order: 0 } },
      { where: { id: "f-name" }, data: { order: 1 } },
      { where: { id: "f-email" }, data: { order: 2 } },
    ])
  })

  it("clamps an out-of-range order to the end", async () => {
    const updated = await updateFieldForUser("user-1", "form-1", "f-name", {
      order: 99,
    })
    expect(updated.order).toBe(2)
    expect(orderWrites()).toEqual([
      { where: { id: "f-email" }, data: { order: 0 } },
      { where: { id: "f-message" }, data: { order: 1 } },
      { where: { id: "f-name" }, data: { order: 2 } },
    ])
  })

  it("leaves orders alone when no order is sent", async () => {
    await updateFieldForUser("user-1", "form-1", "f-email", {
      label: "Email address",
    })
    expect(mockDb.formField.update).toHaveBeenCalledTimes(1)
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })
})

describe("addFieldToForm order (DSH-105)", () => {
  it("inserting at order 0 shifts the siblings down", async () => {
    mockDb.form.findFirst.mockResolvedValue(
      makeForm({ fields: ORDERED_FIELDS })
    )
    const field = await addFieldToForm("user-1", "form-1", {
      name: "topic",
      label: "Topic",
      type: "TEXT",
      required: false,
      order: 0,
    })
    expect(field.order).toBe(0)
    expect(orderWrites()).toEqual([
      { where: { id: "field-1" }, data: { order: 0 } },
      { where: { id: "f-name" }, data: { order: 1 } },
      { where: { id: "f-email" }, data: { order: 2 } },
      { where: { id: "f-message" }, data: { order: 3 } },
    ])
  })
})

describe("deleteFieldForUser order (DSH-105)", () => {
  it("re-sequences the survivors after a delete", async () => {
    mockDb.form.findFirst.mockResolvedValue(
      makeForm({ fields: ORDERED_FIELDS })
    )
    await deleteFieldForUser("user-1", "form-1", "f-name")
    expect(orderWrites()).toEqual([
      { where: { id: "f-email" }, data: { order: 0 } },
      { where: { id: "f-message" }, data: { order: 1 } },
    ])
  })
})

describe("addNotificationEmailToForm", () => {
  it("normalizes the address and refuses duplicates with 409", async () => {
    const created = await addNotificationEmailToForm("user-1", "form-1", {
      email: "  Owner@Example.COM ",
    })
    expect(created.email).toBe("owner@example.com")
    mockDb.notificationSettings.findUnique.mockResolvedValue({ id: "n-1" })
    await expectApiError(
      addNotificationEmailToForm("user-1", "form-1", {
        email: "owner@example.com",
      }),
      409
    )
  })

  // DB-028: the pre-check is not enough — a concurrent duplicate
  // recipient surfaces as P2002, which is a 409, never a 500.
  it("maps a concurrent duplicate recipient (P2002) to 409, never 500", async () => {
    mockDb.notificationSettings.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "7",
      })
    )
    await expectApiError(
      addNotificationEmailToForm("user-1", "form-1", {
        email: "owner@example.com",
      }),
      409
    )
  })

  it("creates the recipient disabled with a 24h confirmation token", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const created = await addNotificationEmailToForm("user-1", "form-1", {
      email: "owner@example.com",
    })
    expect(created.enabled).toBe(false)
    expect(mockDb.verification.create).toHaveBeenCalledOnce()
    const tokenArgs = mockDb.verification.create.mock.calls[0][0] as {
      data: { identifier: string; value: string; expiresAt: Date }
    }
    expect(tokenArgs.data.identifier).toBe("notification-confirm:notif-1")
    expect(tokenArgs.data.value.length).toBeGreaterThan(20)
    const ttlMs = tokenArgs.data.expiresAt.getTime() - Date.now()
    expect(ttlMs).toBeGreaterThan(23 * 60 * 60 * 1000)
    expect(ttlMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
    const line = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("[recipient-confirm]"))
    expect(line).toContain("?token=<redacted>")
    expect(line).not.toContain(tokenArgs.data.value)
  })
})

describe("listFormsPageForUser (DSH-107)", () => {
  it("pages, searches, and clamps perPage at the service", async () => {
    mockDb.form.count.mockResolvedValue(3)
    mockDb.form.findMany.mockResolvedValue([makeForm({ id: "form-2" })])
    const page = await listFormsPageForUser("user-1", {
      search: "contact",
      page: 2,
      perPage: 1,
    })
    expect(page.total).toBe(3)
    expect(page.page).toBe(2)
    expect(page.perPage).toBe(1)
    expect(page.items).toHaveLength(1)
    expect(mockDb.form.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: { contains: "contact", mode: "insensitive" },
        }),
        skip: 1,
        take: 1,
      })
    )
    const huge = await listFormsPageForUser("user-1", { perPage: 500 })
    expect(huge.perPage).toBe(100)
    expect(mockDb.form.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 })
    )
  })
})

describe("confirmNotificationEmail", () => {
  function mockPendingToken(expiresAt: Date) {
    mockDb.verification.findFirst.mockResolvedValue({
      id: "verif-1",
      identifier: "notification-confirm:notif-1",
      value: "tok-abc-123",
      expiresAt,
    })
    mockDb.notificationSettings.findUnique.mockResolvedValue({
      id: "notif-1",
      formId: "form-1",
      email: "owner@example.com",
      enabled: false,
    })
  }

  it("enables the recipient and deletes the single-use token", async () => {
    mockPendingToken(new Date(Date.now() + 60 * 60 * 1000))
    const result = await confirmNotificationEmail("form-1", "tok-abc-123")
    expect(result).toEqual({
      formId: "form-1",
      notificationId: "notif-1",
      email: "owner@example.com",
    })
    expect(mockDb.notificationSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "notif-1" },
        data: { enabled: true },
      })
    )
    expect(mockDb.verification.delete).toHaveBeenCalledWith({
      where: { id: "verif-1" },
    })
  })

  it("rejects an unknown token with 404", async () => {
    mockDb.verification.findFirst.mockResolvedValue(null)
    await expectApiError(confirmNotificationEmail("form-1", "nope"), 404)
    expect(mockDb.notificationSettings.update).not.toHaveBeenCalled()
  })

  it("rejects an expired token with 410 and leaves the row disabled", async () => {
    mockPendingToken(new Date(Date.now() - 1000))
    await expectApiError(confirmNotificationEmail("form-1", "tok-abc-123"), 410)
    expect(mockDb.notificationSettings.update).not.toHaveBeenCalled()
  })

  it("rejects a token for a different form with 404", async () => {
    mockPendingToken(new Date(Date.now() + 60 * 60 * 1000))
    await expectApiError(
      confirmNotificationEmail("form-other", "tok-abc-123"),
      404
    )
    expect(mockDb.notificationSettings.update).not.toHaveBeenCalled()
  })
})

describe("updateNotificationEmailForUser (EML-004 guard)", () => {
  function mockRow() {
    mockDb.form.findFirst.mockResolvedValue(
      makeForm({
        notificationSettings: [
          { id: "notif-1", email: "owner@example.com", enabled: false },
        ],
      })
    )
  }

  it("refuses to switch on an unconfirmed recipient with 409", async () => {
    mockRow()
    mockDb.verification.findFirst.mockResolvedValue({ id: "verif-1" })
    await expectApiError(
      updateNotificationEmailForUser("user-1", "form-1", "notif-1", {
        enabled: true,
      }),
      409
    )
    expect(mockDb.notificationSettings.update).not.toHaveBeenCalled()
  })

  it("allows switching on a previously confirmed recipient", async () => {
    mockRow()
    mockDb.verification.findFirst.mockResolvedValue(null)
    const updated = await updateNotificationEmailForUser(
      "user-1",
      "form-1",
      "notif-1",
      { enabled: true }
    )
    expect(updated.enabled).toBe(true)
  })

  it("writes a notification-updated audit row on toggle (DSH-206)", async () => {
    mockRow()
    mockDb.verification.findFirst.mockResolvedValue(null)
    await updateNotificationEmailForUser("user-1", "form-1", "notif-1", {
      enabled: true,
    })
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resourceId: "form-1",
          detail: expect.objectContaining({
            event: "notification-updated",
            email: "owner@example.com",
            enabled: true,
          }),
        }),
      })
    )
  })
})

describe("resendNotificationConfirmation", () => {
  function mockRow(enabled: boolean) {
    mockDb.form.findFirst.mockResolvedValue(
      makeForm({
        notificationSettings: [
          { id: "notif-1", email: "owner@example.com", enabled },
        ],
      })
    )
  }

  it("replaces the stale token and re-sends for an unconfirmed recipient", async () => {
    mockRow(false)
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await resendNotificationConfirmation("user-1", "form-1", "notif-1")
    expect(mockDb.verification.deleteMany).toHaveBeenCalledWith({
      where: { identifier: "notification-confirm:notif-1" },
    })
    expect(mockDb.verification.create).toHaveBeenCalledOnce()
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "[recipient-confirm]"
    )
  })

  it("refuses to resend for an already confirmed recipient with 409", async () => {
    mockRow(true)
    await expectApiError(
      resendNotificationConfirmation("user-1", "form-1", "notif-1"),
      409
    )
    expect(mockDb.verification.create).not.toHaveBeenCalled()
  })
})

describe("deleteNotificationEmailForUser", () => {
  it("removes the pending confirmation token with the recipient", async () => {
    mockDb.form.findFirst.mockResolvedValue(
      makeForm({
        notificationSettings: [
          { id: "notif-1", email: "owner@example.com", enabled: false },
        ],
      })
    )
    await deleteNotificationEmailForUser("user-1", "form-1", "notif-1")
    expect(mockDb.notificationSettings.delete).toHaveBeenCalledWith({
      where: { id: "notif-1" },
    })
    expect(mockDb.verification.deleteMany).toHaveBeenCalledWith({
      where: { identifier: "notification-confirm:notif-1" },
    })
  })
})

describe("getFormForUser (EML-004 surfacing)", () => {
  it("marks recipients with a pending token as unconfirmed", async () => {
    mockDb.form.findFirst.mockResolvedValue(
      makeForm({
        notificationSettings: [
          { id: "n-1", email: "a@example.com", enabled: false },
          { id: "n-2", email: "b@example.com", enabled: true },
        ],
      })
    )
    mockDb.verification.findMany.mockResolvedValue([
      { identifier: "notification-confirm:n-1" },
    ])
    const form = await getFormForUser("user-1", "form-1")
    expect(form.notificationSettings).toEqual([
      { id: "n-1", email: "a@example.com", enabled: false, confirmed: false },
      { id: "n-2", email: "b@example.com", enabled: true, confirmed: true },
    ])
  })

  it("exposes the next digest due date (DSH-304)", async () => {
    const lastDigestAt = new Date("2026-11-20T10:00:00Z")
    mockDb.form.findFirst.mockResolvedValue(
      makeForm({
        lastDigestAt,
        digestIntervalHours: 24,
      })
    )
    const form = await getFormForUser("user-1", "form-1")
    expect(form.digestNextAt).toEqual(new Date("2026-11-21T10:00:00Z"))
  })

  it("reports no next digest when none was ever sent (DSH-304)", async () => {
    mockDb.form.findFirst.mockResolvedValue(
      makeForm({ lastDigestAt: null, digestIntervalHours: null })
    )
    const form = await getFormForUser("user-1", "form-1")
    expect(form.digestNextAt).toBeNull()
  })
})

describe("deleteFormForUser (SRC-208 archive)", () => {
  it("refuses to archive without the matching confirmation token", async () => {
    await expectApiError(
      deleteFormForUser("user-1", "form-1", "Wrong name"),
      422
    )
    await expectApiError(deleteFormForUser("user-1", "form-1", ""), 422)
    expect(mockDb.form.update).not.toHaveBeenCalled()
    expect(mockDb.form.delete).not.toHaveBeenCalled()
  })

  it("archives instead of physically deleting, and audits form-archived", async () => {
    await deleteFormForUser("user-1", "form-1", "Contact us")
    expect(mockDb.form.update).toHaveBeenCalledWith({
      where: { id: "form-1" },
      data: { deletedAt: expect.any(Date) },
    })
    // SRC-208: the physical delete is gone — submissions, events,
    // settings and email jobs survive the archive.
    expect(mockDb.form.delete).not.toHaveBeenCalled()
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resourceId: "form-1",
          detail: expect.objectContaining({
            event: "form-archived",
            name: "Contact us",
          }),
        }),
      })
    )
  })

  it("hides archived forms from the ownership lookup", async () => {
    mockDb.form.findFirst.mockResolvedValue(null)
    await expectApiError(
      deleteFormForUser("user-1", "form-1", "Contact us"),
      404
    )
    expect(mockDb.form.update).not.toHaveBeenCalled()
  })
})
