import { describe, expect, it, vi } from "vitest"

const mockGenerateObject = vi.hoisted(() => vi.fn())
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>()
  return { ...actual, generateObject: mockGenerateObject }
})
import { draftReply } from "@sendcms/ai"

// A stand-in model — the provider factories are covered by
// ai-provider.test.ts; here only the prompt + parsing matter.
const fakeModel = { modelId: "test-model" } as never

describe("draftReply", () => {
  it("asks the model for a reply draft and returns it", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        subject: "Re: your order question",
        body: "Hi Ali, thanks for writing. Your order is on its way.",
      },
    })
    const draft = await draftReply({
      model: fakeModel,
      formName: "Contact us",
      submission: {
        senderName: "Ali",
        senderEmail: "ali@example.com",
        content: "Where is my order?",
        receivedAt: new Date("2026-11-20T10:00:00Z"),
      },
    })
    expect(draft).toEqual({
      subject: "Re: your order question",
      body: "Hi Ali, thanks for writing. Your order is on its way.",
    })
    const call = mockGenerateObject.mock.calls[0][0] as {
      model: unknown
      prompt: string
    }
    expect(call.model).toBe(fakeModel)
    expect(call.prompt).toContain('Form: "Contact us"')
    expect(call.prompt).toContain("Where is my order?")
  })

  it("rejects a draft with an empty body", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { subject: "Hi", body: "" },
    })
    await expect(
      draftReply({
        model: fakeModel,
        formName: "Contact us",
        submission: {
          senderName: null,
          senderEmail: "a@example.com",
          content: "Hello",
          receivedAt: new Date(),
        },
      })
    ).rejects.toThrow()
  })
})
