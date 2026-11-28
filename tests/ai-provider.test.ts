import { describe, expect, it } from "vitest"
import {
  AI_PROVIDERS,
  DEFAULT_MODELS,
  MismatchedAiModelError,
  UnknownAiProviderError,
  getAiModel,
  getAiModelId,
  getAiProviderConfigError,
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

  // AIM-024: the throw is a typed error carrying the bad value, so
  // callers can convert it to a 503 naming the value instead of a
  // generic "AI is not available" — and the worker can log it.
  it("throws UnknownAiProviderError naming the bad value", () => {
    try {
      resolveAiProvider({ AI_PROVIDER: "goggle" })
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownAiProviderError)
      expect((err as UnknownAiProviderError).provider).toBe("goggle")
      expect((err as Error).message).toMatch(/Unknown AI_PROVIDER "goggle"/)
    }
  })

  it("matches an explicit AI_PROVIDER case-insensitively (SRC-325)", () => {
    expect(
      resolveAiProvider({ AI_PROVIDER: "GOOGLE", OPENAI_API_KEY: "sk-x" })
    ).toBe("google")
    expect(resolveAiProvider({ AI_PROVIDER: "  OpenAI  " })).toBe("openai")
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

  // AIM-024: still false for a bogus provider (the throw stays
  // swallowed here by design) — the worker tells the two apart with
  // getAiProviderConfigError below.
  it("is false for an unknown AI_PROVIDER", () => {
    expect(isAiConfigured({ AI_PROVIDER: "goggle" })).toBe(false)
  })
})

// AIM-024: the worker-side companion to isAiConfigured — the
// misconfiguration message when the explicit provider is unknown,
// null otherwise, so a silent skip can log the bad value.
describe("getAiProviderConfigError", () => {
  it("returns the unknown-provider message for a bogus AI_PROVIDER", () => {
    expect(getAiProviderConfigError({ AI_PROVIDER: "goggle" })).toMatch(
      /Unknown AI_PROVIDER "goggle"/
    )
  })

  it("returns null when the provider is known or unset", () => {
    expect(getAiProviderConfigError({})).toBeNull()
    expect(
      getAiProviderConfigError({
        AI_PROVIDER: "google",
        GOOGLE_GENERATIVE_AI_API_KEY: "key",
      })
    ).toBeNull()
  })
})

describe("getAiModelId", () => {
  it("returns the provider default and honors an AI_MODEL override", () => {
    expect(getAiModelId("openai", {})).toBe(DEFAULT_MODELS.openai)
    expect(getAiModelId("google", { AI_MODEL: "gemini-2.0-flash" })).toBe(
      "gemini-2.0-flash"
    )
  })

  // AIM-027: a model id that clearly belongs to another provider is
  // rejected before any model call, naming the mismatch.
  it("rejects a wrong-provider AI_MODEL naming both providers", () => {
    expect(() => getAiModelId("google", { AI_MODEL: "gpt-4o-mini" })).toThrow(
      MismatchedAiModelError
    )
    expect(() => getAiModelId("google", { AI_MODEL: "gpt-4o-mini" })).toThrow(
      /looks like an openai model, not a google model/
    )
    expect(() =>
      getAiModelId("openai", { AI_MODEL: "claude-haiku-4-5" })
    ).toThrow(/looks like an anthropic model/)
    expect(() =>
      getAiModelId("google", { AI_MODEL: "openai/gpt-4o-mini" })
    ).toThrow(/looks like an openrouter model/)
  })

  it("accepts an OpenRouter vendor/model id for openrouter", () => {
    expect(getAiModelId("openrouter", { AI_MODEL: "openai/gpt-4o-mini" })).toBe(
      "openai/gpt-4o-mini"
    )
  })

  // An id matching no provider's prefix is not attributed — a new
  // model must never be rejected for being unknown.
  it("passes an unknown model id through untouched", () => {
    expect(getAiModelId("google", { AI_MODEL: "learnlm-2.0-flash" })).toBe(
      "learnlm-2.0-flash"
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

  // AIM-027: the wrong-provider override fails at resolution, before
  // any model call is attempted.
  it("throws a named error for a wrong-provider AI_MODEL", () => {
    expect(() =>
      getAiModel({
        AI_PROVIDER: "google",
        GOOGLE_GENERATIVE_AI_API_KEY: "key",
        AI_MODEL: "gpt-4o-mini",
      })
    ).toThrow(/looks like an openai model, not a google model/)
  })
})
