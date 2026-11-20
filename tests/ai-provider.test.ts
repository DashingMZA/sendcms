import { describe, expect, it } from "vitest"
import {
  AI_PROVIDERS,
  DEFAULT_MODELS,
  getAiModel,
  getAiModelId,
  isAiConfigured,
  resolveAiProvider,
} from "@sendcms/ai"

const KEYS = {
  OPENAI_API_KEY: "sk-openai",
  ANTHROPIC_API_KEY: "sk-anthropic",
  GOOGLE_GENERATIVE_AI_API_KEY: "google-key",
  DEEPSEEK_API_KEY: "deepseek-key",
  OPENROUTER_API_KEY: "openrouter-key",
} as const

describe("resolveAiProvider", () => {
  it("returns none when no provider key is set", () => {
    expect(resolveAiProvider({})).toBe("none")
  })

  it("detects the provider from whichever key is set", () => {
    expect(resolveAiProvider({ OPENAI_API_KEY: "sk-x" })).toBe("openai")
    expect(resolveAiProvider({ ANTHROPIC_API_KEY: "sk-x" })).toBe("anthropic")
    expect(resolveAiProvider({ GOOGLE_GENERATIVE_AI_API_KEY: "key" })).toBe(
      "google"
    )
    expect(resolveAiProvider({ DEEPSEEK_API_KEY: "key" })).toBe("deepseek")
    expect(resolveAiProvider({ OPENROUTER_API_KEY: "key" })).toBe("openrouter")
  })

  it("lets an explicit AI_PROVIDER win over a different key", () => {
    expect(
      resolveAiProvider({ AI_PROVIDER: "deepseek", OPENAI_API_KEY: "sk-x" })
    ).toBe("deepseek")
  })

  it("throws on an unknown explicit AI_PROVIDER", () => {
    expect(() => resolveAiProvider({ AI_PROVIDER: "cohere" })).toThrow(
      /Unknown AI_PROVIDER/
    )
  })

  it("covers all five providers the owner named", () => {
    expect([...AI_PROVIDERS]).toEqual([
      "openai",
      "anthropic",
      "google",
      "deepseek",
      "openrouter",
    ])
  })
})

describe("isAiConfigured", () => {
  it("is false with no keys and true with a provider plus its key", () => {
    expect(isAiConfigured({})).toBe(false)
    expect(isAiConfigured({ OPENAI_API_KEY: "sk-x" })).toBe(true)
  })

  it("is false when the selected provider's key is missing", () => {
    expect(
      isAiConfigured({ AI_PROVIDER: "openai", ANTHROPIC_API_KEY: "sk-x" })
    ).toBe(false)
  })
})

describe("getAiModelId", () => {
  it("returns the provider default and honors an AI_MODEL override", () => {
    expect(getAiModelId("openai", {})).toBe(DEFAULT_MODELS.openai)
    expect(getAiModelId("google", { AI_MODEL: "gemini-2.0-flash" })).toBe(
      "gemini-2.0-flash"
    )
  })
})

describe("getAiModel", () => {
  it("returns a model with the default id for every provider", () => {
    for (const provider of AI_PROVIDERS) {
      const keyVar =
        provider === "google"
          ? "GOOGLE_GENERATIVE_AI_API_KEY"
          : (`${provider.toUpperCase()}_API_KEY` as keyof typeof KEYS)
      const model = getAiModel({ [keyVar]: KEYS[keyVar] })
      // LanguageModel is a union that includes a plain string id
      // (gateway), so narrow to the model objects before reading
      // modelId — the provider factories always return an object.
      expect(typeof model).toBe("object")
      if (typeof model === "object") {
        expect(model.modelId).toBe(DEFAULT_MODELS[provider])
      }
    }
  })

  it("honors an AI_MODEL override", () => {
    const model = getAiModel({
      AI_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-x",
      AI_MODEL: "gpt-4o",
    })
    expect(typeof model).toBe("object")
    if (typeof model === "object") {
      expect(model.modelId).toBe("gpt-4o")
    }
  })

  it("throws a clear error when no provider is configured", () => {
    expect(() => getAiModel({})).toThrow(/No AI provider configured/)
  })

  it("throws a clear error when the selected provider's key is missing", () => {
    expect(() =>
      getAiModel({ AI_PROVIDER: "anthropic", OPENAI_API_KEY: "sk-x" })
    ).toThrow(/ANTHROPIC_API_KEY is not set/)
  })
})
