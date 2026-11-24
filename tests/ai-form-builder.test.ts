import { describe, expect, it, vi } from "vitest"

const mockGenerateObject = vi.hoisted(() => vi.fn())
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>()
  return { ...actual, generateObject: mockGenerateObject }
})
import { suggestFields } from "@sendcms/ai"

// A stand-in model — the provider factories are covered by
// ai-provider.test.ts; here only the prompt + parsing matter.
const fakeModel = { modelId: "test-model" } as never

describe("suggestFields", () => {
  it("asks the model for fields and returns the suggestions", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        fields: [
          {
            name: "company",
            label: "Company",
            type: "TEXT",
            required: false,
          },
          {
            name: "reason",
            label: "Reason for writing",
            type: "SELECT",
            required: true,
            options: ["Support", "Sales", "Other"],
          },
        ],
      },
    })
    const result = await suggestFields({
      model: fakeModel,
      prompt: "A contact form that also asks for the company and the reason",
      existingFields: [
        { name: "name", label: "Name", type: "TEXT" },
        { name: "email", label: "Email", type: "EMAIL" },
      ],
    })
    expect(result.fields).toHaveLength(2)
    expect(result.fields[0]).toMatchObject({
      name: "company",
      label: "Company",
      type: "TEXT",
    })
    const call = mockGenerateObject.mock.calls[0][0] as {
      model: unknown
      prompt: string
    }
    expect(call.model).toBe(fakeModel)
    expect(call.prompt).toContain("company and the reason")
    expect(call.prompt).toContain("name (TEXT")
  })

  // AIM-022: the owner's description is delimited, never pasted bare
  // into the prompt.
  it("delimits the form description instead of pasting it bare", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        fields: [
          { name: "company", label: "Company", type: "TEXT", required: false },
        ],
      },
    })
    await suggestFields({
      model: fakeModel,
      prompt: "A contact form that also asks for the company",
      existingFields: [],
    })
    const call = mockGenerateObject.mock.calls[0][0] as {
      prompt: string
    }
    expect(call.prompt).toContain("--- BEGIN UNTRUSTED SUBMISSION DATA ---")
    expect(call.prompt).toContain("--- END UNTRUSTED SUBMISSION DATA ---")
    expect(call.prompt).toContain("asks for the company")
    expect(call.prompt).not.toContain('Description: "A contact form')
  })

  it("rejects a field name that is not lowercase snake_case", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        fields: [
          {
            name: "Full Name",
            label: "Full Name",
            type: "TEXT",
            required: true,
          },
        ],
      },
    })
    await expect(
      suggestFields({ model: fakeModel, prompt: "x", existingFields: [] })
    ).rejects.toThrow()
  })

  it("rejects an unknown field type", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        fields: [
          { name: "color", label: "Color", type: "COLOR", required: false },
        ],
      },
    })
    await expect(
      suggestFields({ model: fakeModel, prompt: "x", existingFields: [] })
    ).rejects.toThrow()
  })
})
