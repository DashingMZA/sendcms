import { createAnthropic } from "@ai-sdk/anthropic"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"

import type { LanguageModel } from "ai"

// AI provider plumbing (Phase 12, Step 1b). This package owns the
// Vercel AI SDK wiring and nothing else: which provider to use, which
// key it needs, and which model to call. No capability (spam
// re-scoring, digest, form-builder, reply drafts) lives here — those
// call `getAiModel()` from their own steps and check the form's
// `aiEnabled` opt-in first (ADR 0010, Decision 4).
//
// Provider selection follows the email package's shape
// (@sendcms/email/provider.ts): an explicit `AI_PROVIDER` wins;
// otherwise the provider is detected from whichever key is set.
// Model calls are server-side only — never in the browser, never in
// the public SDK bundle (a key there would leak).

export const AI_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "openrouter",
] as const

export type AiProviderName = (typeof AI_PROVIDERS)[number]
export type AiProvider = AiProviderName | "none"

/**
 * Token usage a provider reports for one model call. The Vercel AI
 * SDK attaches it to every generateObject/generateText result; a
 * null means the provider did not report usage for that call (the
 * caller records the call with null tokens, never an estimate).
 * The capability functions surface it through an optional `onUsage`
 * callback so the caller can attribute the call (BYOK vs platform)
 * without changing the capability's return value.
 */
export type AiCallUsage = {
  promptTokens: number
  completionTokens: number
}

/** Normalizes the SDK's usage object (or its absence) to AiCallUsage.
    AI SDK 7 reports `inputTokens`/`outputTokens`; the legacy
    `promptTokens`/`completionTokens` names are accepted too. */
export function toAiCallUsage(
  usage:
    | {
        inputTokens?: number
        outputTokens?: number
        promptTokens?: number
        completionTokens?: number
      }
    | null
    | undefined
): AiCallUsage | null {
  const promptTokens =
    typeof usage?.inputTokens === "number"
      ? usage.inputTokens
      : typeof usage?.promptTokens === "number"
        ? usage.promptTokens
        : undefined
  const completionTokens =
    typeof usage?.outputTokens === "number"
      ? usage.outputTokens
      : typeof usage?.completionTokens === "number"
        ? usage.completionTokens
        : undefined
  if (
    typeof promptTokens === "number" &&
    typeof completionTokens === "number"
  ) {
    return {
      promptTokens,
      completionTokens,
    }
  }
  return null
}

/** The API-key env var each provider reads. */
export const PROVIDER_ENV_VARS: Record<AiProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
}

/**
 * The explicit AI environment a service needs — only the provider
 * keys that are set, the explicit provider choice, and the model
 * override. Routes build this from the ambient environment with
 * pickAiEnvConfig; services receive it instead of the whole
 * process.env (SRC-123), so a service can never read an unrelated
 * secret (DATABASE_URL, BETTER_AUTH_SECRET, …) from its env arg.
 */
export type AiEnvConfig = {
  apiKeys: Partial<Record<AiProviderName, string>>
  provider?: string
  modelId?: string
}

/** Picks exactly the vars the AI resolver reads out of an environment. */
export function pickAiEnvConfig(env: NodeJS.ProcessEnv): AiEnvConfig {
  const apiKeys: Partial<Record<AiProviderName, string>> = {}
  for (const provider of AI_PROVIDERS) {
    const key = env[PROVIDER_ENV_VARS[provider]]
    if (key) apiKeys[provider] = key
  }
  return {
    apiKeys,
    ...(env.AI_PROVIDER?.trim() ? { provider: env.AI_PROVIDER.trim() } : {}),
    ...(env.AI_MODEL?.trim() ? { modelId: env.AI_MODEL.trim() } : {}),
  }
}

/** Expands an AiEnvConfig back into the minimal env record the
    resolver's env-based helpers read (resolveAiProvider,
    getAiModelId, isAiConfigured). Only the picked vars are present —
    nothing else from the ambient environment leaks in. */
export function aiEnvConfigToEnv(config: AiEnvConfig): NodeJS.ProcessEnv {
  // ProcessEnv requires NODE_ENV, so the record is built as a plain
  // object and cast — every key written below is an AI var.
  const env = {} as NodeJS.ProcessEnv
  for (const [provider, key] of Object.entries(config.apiKeys)) {
    env[PROVIDER_ENV_VARS[provider as AiProviderName]] = key
  }
  if (config.provider) env.AI_PROVIDER = config.provider
  if (config.modelId) env.AI_MODEL = config.modelId
  return env
}

/** An AiEnvConfig carries its keys as an object; a whole environment
    carries them as individual string vars. (A plain `"apiKeys" in env`
    check cannot narrow the union — ProcessEnv's index signature
    claims every key — so the guard reads the property's type.) */
function isAiEnvConfig(
  env: NodeJS.ProcessEnv | AiEnvConfig
): env is AiEnvConfig {
  return (
    typeof (env as AiEnvConfig).apiKeys === "object" &&
    (env as AiEnvConfig).apiKeys !== null
  )
}

/** Accepts either a whole environment (legacy callers) or an explicit
    config (SRC-123) and returns the env record the resolver reads. */
export function normalizeAiEnv(
  env: NodeJS.ProcessEnv | AiEnvConfig
): NodeJS.ProcessEnv {
  return isAiEnvConfig(env) ? aiEnvConfigToEnv(env) : env
}

/** Default model per provider. `AI_MODEL` overrides the default for
    whichever provider is selected.
    Google default (2026-11-20): `gemini-3.5-flash-lite`. Google retired
    `gemini-2.5-flash` for new API keys (it 404s with "no longer
    available to new users"); `gemini-3.8-flash` (the error's own
    suggestion) works but is heavily overloaded on the free tier
    (503 "currently experiencing high demand"). `gemini-3.5-flash-lite`
    is Google's official replacement for 2.5-flash (Dec 1 routing)
    and the lite tier, so it is the least-loaded option. */
export const DEFAULT_MODELS: Record<AiProviderName, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
  google: "gemini-3.5-flash-lite",
  deepseek: "deepseek-chat",
  openrouter: "openai/gpt-4o-mini",
}

/** Resolves the configured provider. Throws on an unknown explicit
    `AI_PROVIDER` — that is a misconfiguration, not a missing key. */
export function resolveAiProvider(
  env: NodeJS.ProcessEnv = process.env
): AiProvider {
  const selected = env.AI_PROVIDER?.trim()
  if (selected) {
    if ((AI_PROVIDERS as readonly string[]).includes(selected)) {
      return selected as AiProviderName
    }
    throw new Error(
      `Unknown AI_PROVIDER "${selected}" (expected one of: ${AI_PROVIDERS.join(", ")}).`
    )
  }
  for (const provider of AI_PROVIDERS) {
    if (env[PROVIDER_ENV_VARS[provider]]) return provider
  }
  return "none"
}

/** True when a provider AND its key are configured. Capabilities use
    this to degrade to the non-AI behavior instead of throwing. */
export function isAiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const provider = resolveAiProvider(env)
    return provider !== "none" && Boolean(env[PROVIDER_ENV_VARS[provider]])
  } catch {
    return false
  }
}

/** The model id for a provider: `AI_MODEL` when set, else the
    provider's default. */
export function getAiModelId(
  provider: AiProviderName,
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.AI_MODEL?.trim() || DEFAULT_MODELS[provider]
}

/**
 * Builds a provider's language model from an EXPLICIT api key (a
 * decrypted BYOK key, or a browser-only key passed per request).
 * The key is used for this one model only — it is never stored,
 * logged, or sent to any other provider. `modelId` defaults to the
 * provider's default when omitted.
 */
export function getAiModelForKey(
  provider: AiProviderName,
  apiKey: string,
  modelId?: string
): LanguageModel {
  const id = modelId?.trim() || DEFAULT_MODELS[provider]
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey })(id)
    case "anthropic":
      return createAnthropic({ apiKey })(id)
    case "google":
      return createGoogleGenerativeAI({ apiKey })(id)
    case "deepseek":
      return createDeepSeek({ apiKey })(id)
    case "openrouter":
      return createOpenRouter({ apiKey })(id)
  }
}

/** Returns the configured provider's language model. Throws a clear
    error when no provider is configured, or when the selected
    provider's key is missing — callers decide whether that is a loud
    failure or a reason to degrade to the non-AI behavior. */
export function getAiModel(
  env: NodeJS.ProcessEnv = process.env
): LanguageModel {
  const provider = resolveAiProvider(env)
  if (provider === "none") {
    throw new Error(
      "No AI provider configured (set AI_PROVIDER plus its key: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, DEEPSEEK_API_KEY or OPENROUTER_API_KEY)."
    )
  }
  const keyVar = PROVIDER_ENV_VARS[provider]
  const apiKey = env[keyVar]
  if (!apiKey) {
    throw new Error(`AI_PROVIDER is "${provider}" but ${keyVar} is not set.`)
  }
  const modelId = getAiModelId(provider, env)
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey })(modelId)
    case "anthropic":
      return createAnthropic({ apiKey })(modelId)
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId)
    case "deepseek":
      return createDeepSeek({ apiKey })(modelId)
    case "openrouter":
      return createOpenRouter({ apiKey })(modelId)
  }
}
