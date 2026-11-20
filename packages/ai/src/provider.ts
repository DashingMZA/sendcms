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

/** The API-key env var each provider reads. */
export const PROVIDER_ENV_VARS: Record<AiProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
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
