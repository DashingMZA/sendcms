// AI-assisted form building (Phase 12, Step 4) with a mocked Prisma
// client and a mocked AI package. Pins the orchestration — the
// aiEnabled opt-in, the no-provider 503, and that the service only
// returns suggestions, never creates a field.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  form: { findFirst: vi.fn() },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
const mockAi = vi.hoisted(() => ({
  isAiConfigured: vi.fn(() => true),
  getAiModel: vi.fn(() => ({ modelId: "test-model" })),
  suggestFields: vi.fn(async () => ({
    fields: [
      { name: "company", label: "Company", type: "TEXT", required: false },
    ],
  })),
}))
vi.mock("@sendcms/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/ai")>()
  // The real normalizeAiEnv stays live: the resolver normalizes the
  // explicit AiEnvConfig the tests pass (SRC-123) back to the env
  // record its legacy path reads.
  return { ...actual, ...mockAi }
})
vi.mock("@sendcms/security", () => ({ logAudit: vi.fn(async () => {}) }))

import { suggestFieldsForForm } from "@sendcms/forms"

const AI_ENV = { apiKeys: { openai: "sk-test" } }

function makeForm(overrides: Record<string, unknown> = {}) {
  return {
    id: "form-1",
    name: "Contact us",
    aiEnabled: true,
    fields: [
      { name: "name", label: "Name", type: "TEXT" },
      { name: "email", label: "Email", type: "EMAIL" },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAi.isAiConfigured.mockReturnValue(true)
  mockDb.form.findFirst.mockResolvedValue(makeForm())
  mockAi.suggestFields.mockResolvedValue({
    fields: [
      { name: "company", label: "Company", type: "TEXT", required: false },
    ],
  })
})

describe("suggestFieldsForForm", () => {
  it("returns the model's suggestions with the existing fields", async () => {
    const result = await suggestFieldsForForm(
      "user-1",
      "form-1",
      "ask for the company too",
      AI_ENV
    )
    expect(result.fields).toHaveLength(1)
    expect(result.fields[0].name).toBe("company")
    expect(mockAi.suggestFields).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "ask for the company too",
        existingFields: [
          { name: "name", label: "Name", type: "TEXT" },
          { name: "email", label: "Email", type: "EMAIL" },
        ],
      })
    )
  })

  it("refuses when AI is off for the form", async () => {
    mockDb.form.findFirst.mockResolvedValue(makeForm({ aiEnabled: false }))
    await expect(
      suggestFieldsForForm("user-1", "form-1", "ask for the company", AI_ENV)
    ).rejects.toMatchObject({ status: 403 })
    expect(mockAi.suggestFields).not.toHaveBeenCalled()
  })

  it("refuses with 503 when no provider is configured", async () => {
    mockAi.isAiConfigured.mockReturnValue(false)
    await expect(
      suggestFieldsForForm("user-1", "form-1", "ask for the company", AI_ENV)
    ).rejects.toMatchObject({ status: 503 })
    expect(mockAi.suggestFields).not.toHaveBeenCalled()
  })

  it("throws 404 for a form the user does not own", async () => {
    mockDb.form.findFirst.mockResolvedValue(null)
    await expect(
      suggestFieldsForForm("user-1", "form-1", "ask for the company", AI_ENV)
    ).rejects.toMatchObject({ status: 404 })
  })
})
