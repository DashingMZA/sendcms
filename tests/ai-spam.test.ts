import { describe, expect, it, vi } from "vitest"

const mockGenerateObject = vi.hoisted(() => vi.fn())
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>()
  return { ...actual, generateObject: mockGenerateObject }
})
import {
  DEFAULT_SPAM_THRESHOLD,
  getSpamThreshold,
  rescoreSpam,
} from "@sendcms/ai"

// A stand-in model — the provider factories are covered by
// ai-provider.test.ts; here only the prompt + parsing matter.
const fakeModel = { modelId: "test-model" } as never

describe("rescoreSpam", () => {
  it("asks the model to score the submission and returns its verdict", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { score: 92, reason: "Unsolicited SEO link scheme." },
    })
    const verdict = await rescoreSpam({
      model: fakeModel,
      formName: "Contact us",
      data: { name: "Spammer", message: "Buy cheap backlinks now!" },
    })
    expect(verdict).toEqual({
      score: 92,
      reason: "Unsolicited SEO link scheme.",
    })
    const call = mockGenerateObject.mock.calls[0][0] as {
      model: unknown
      prompt: string
    }
    expect(call.model).toBe(fakeModel)
    expect(call.prompt).toContain('Form: "Contact us"')
    expect(call.prompt).toContain("Buy cheap backlinks now!")
  })

  it("clamps a score outside 0–100 from the model", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { score: 150, reason: "Too high." },
    })
    const verdict = await rescoreSpam({
      model: fakeModel,
      formName: "Contact us",
      data: { message: "hi" },
    })
    expect(verdict.score).toBe(100)
  })

  it("rounds a fractional score from the model", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { score: 72.6, reason: "Likely spam." },
    })
    const verdict = await rescoreSpam({
      model: fakeModel,
      formName: "Contact us",
      data: { message: "hi" },
    })
    expect(verdict.score).toBe(73)
  })
})

describe("getSpamThreshold", () => {
  it("defaults to 70 and honors a valid AI_SPAM_THRESHOLD", () => {
    expect(getSpamThreshold({})).toBe(DEFAULT_SPAM_THRESHOLD)
    expect(getSpamThreshold({})).toBe(70)
    expect(getSpamThreshold({ AI_SPAM_THRESHOLD: "85" })).toBe(85)
  })

  it("clamps out-of-range values and ignores non-numbers", () => {
    expect(getSpamThreshold({ AI_SPAM_THRESHOLD: "150" })).toBe(100)
    expect(getSpamThreshold({ AI_SPAM_THRESHOLD: "-5" })).toBe(0)
    expect(getSpamThreshold({ AI_SPAM_THRESHOLD: "high" })).toBe(70)
  })
})
