// Form service gates (Phase 4) with a mocked Prisma client.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  form: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  domain: { findFirst: vi.fn() },
  formDomain: { findUnique: vi.fn(), create: vi.fn() },
  formField: { findUnique: vi.fn(), create: vi.fn() },
  notificationSettings: { findUnique: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn() },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

import {
  addFieldToForm,
  addNotificationEmailToForm,
  createFormForUser,
  linkDomainToForm,
  updateFormForUser,
} from "@/lib/services/form-service"
import { ApiError } from "@/lib/api/error"

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
  mockDb.auditLog.create.mockResolvedValue({})
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
})
