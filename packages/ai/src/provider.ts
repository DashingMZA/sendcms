import { createAnthropic } from "@ai-sdk/anthropic"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"

import type { LanguageModel } from "ai"

import { estimateAiCallCostMicros } from "./pricing"

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
  /** Micro-dollar cost from the price table (DB-033), or null when
      the model has no price row — never an estimate. */
  costMicros: number | null
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
      costMicros: null,
    }
  }
  return null
}

/** Like toAiCallUsage, but with the call's cost attached from the
    per-model price table (DB-033) — the model id is what the price
    lookup needs, and the capability functions are the ones that
    have it. */
export function toAiCallUsageWithCost(
  modelId: string | null | undefined,
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
  const base = toAiCallUsage(usage)
  if (!base) return null
  return {
    ...base,
    costMicros: estimateAiCallCostMicros(
      modelId,
      base.promptTokens,
      base.completionTokens
    ),
  }
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

/** The model id of a built LanguageModel, for usage/cost
    attribution. The AI SDK's LanguageModel type does not expose
    `modelId` as a plain property (it is a per-provider literal),
    so this reads it structurally — the resolver in
    @sendcms/ai-settings does the same cast. Null when the model
    carries no id (a test double): the caller records the call with
    null cost, never an estimate. */
export function getLanguageModelId(model: LanguageModel): string | null {
  const id = (model as { modelId?: unknown }).modelId
  return typeof id === "string" && id.length > 0 ? id : null
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

/** Thrown by `resolveAiProvider` when the explicit `AI_PROVIDER`
    names no known provider. A distinct class (not a plain Error) so
    callers can tell a misconfiguration from a missing key: the
    interactive resolver converts it to a 503 naming the bad value
    (AIM-024), and the worker logs it instead of silently skipping.
    The message names the bad value — never log the surrounding env
    with it (it may hold keys). */
export class UnknownAiProviderError extends Error {
  readonly provider: string
  constructor(provider: string) {
    super(
      `Unknown AI_PROVIDER "${provider}" (expected one of: ${AI_PROVIDERS.join(", ")}).`
    )
    this.name = "UnknownAiProviderError"
    this.provider = provider
  }
}

/** Thrown by `getAiModelId` when the `AI_MODEL` override clearly
    belongs to a different provider than the one selected (AIM-027).
    Only raised when the id matches another provider's model-id
    prefix — an unknown id passes through untouched, so a new model
    is never rejected for being new. The admin allowlist (per
    provider) is the guard for genuinely unknown ids, and the
    provider itself 404s the rest at call time. */
export class MismatchedAiModelError extends Error {
  readonly provider: AiProviderName
  readonly modelId: string
  readonly looksLike: AiProviderName
  constructor(
    provider: AiProviderName,
    modelId: string,
    looksLike: AiProviderName
  ) {
    super(
      `AI_MODEL "${modelId}" looks like an ${looksLike} model, not a ${provider} model. ` +
        `Set AI_MODEL to a ${provider} model id (default: "${DEFAULT_MODELS[provider]}") or remove the override.`
    )
    this.name = "MismatchedAiModelError"
    this.provider = provider
    this.modelId = modelId
    this.looksLike = looksLike
  }
}

/** Model-id prefixes that belong to each provider — the cross-provider
    check for `AI_MODEL` (AIM-027). OpenRouter ids are `vendor/model`,
    so any id containing `/` belongs to openrouter (empty prefix list).
    Keep this list to unambiguous prefixes only: it must catch
    `gpt-4o-mini` under `google`, never reject a legitimate new id. */
const MODEL_ID_PREFIXES: Record<AiProviderName, string[]> = {
  openai: ["gpt-", "o1", "o3", "o4", "chatgpt-", "codex-"],
  anthropic: ["claude-"],
  google: ["gemini-", "gemma-"],
  deepseek: ["deepseek-"],
  openrouter: [],
}

/** Which provider a model id looks like, from its prefix — null when
    it matches no provider's shape (unknown ids are not attributed). */
function providerForModelId(modelId: string): AiProviderName | null {
  if (modelId.includes("/")) return "openrouter"
  const lower = modelId.toLowerCase()
  for (const provider of AI_PROVIDERS) {
    if (
      MODEL_ID_PREFIXES[provider].some((prefix) => lower.startsWith(prefix))
    ) {
      return provider
    }
  }
  return null
}

/** Resolves the configured provider. Throws on an unknown explicit
    `AI_PROVIDER` — that is a misconfiguration, not a missing key.
    The explicit name is matched case-insensitively (SRC-325:
    `AI_PROVIDER=Google` used to throw "Unknown AI_PROVIDER").
    With no explicit provider, detection order is the AI_PROVIDERS
    order — openai, anthropic, google, deepseek, openrouter — and
    the FIRST provider whose key is set wins (SRC-325: the
    precedence is documented here, not implicit). `AI_MODEL` is a
    global override for whichever provider is selected; a model id
    that clearly belongs to another provider is rejected by
    `getAiModelId` (AIM-027) — the admin allowlist (per provider)
    is the guard for anything else. */
export function resolveAiProvider(
  env: NodeJS.ProcessEnv = process.env
): AiProvider {
  const selected = env.AI_PROVIDER?.trim().toLowerCase()
  if (selected) {
    if ((AI_PROVIDERS as readonly string[]).includes(selected)) {
      return selected as AiProviderName
    }
    throw new UnknownAiProviderError(env.AI_PROVIDER?.trim() ?? "")
  }
  for (const provider of AI_PROVIDERS) {
    if (env[PROVIDER_ENV_VARS[provider]]) return provider
  }
  return "none"
}

/** The unknown-`AI_PROVIDER` misconfiguration, as a message, or null
    when the explicit provider (if any) is known. `isAiConfigured`
    swallows the throw by design (it answers "is any AI usable?"), so
    worker jobs that skip on `!isAiConfigured` call this first and
    log the misconfiguration instead of silently skipping (AIM-024). */
export function getAiProviderConfigError(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  try {
    resolveAiProvider(env)
    return null
  } catch (err) {
    return err instanceof UnknownAiProviderError ? err.message : null
  }
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
    provider's default. An override that clearly belongs to another
    provider (AIM-027: `AI_MODEL=gpt-4o-mini` with
    `AI_PROVIDER=google`) throws `MismatchedAiModelError` before any
    model call — a wrong-provider id used to fail only when the
    provider 404d it at call time, surfacing as a generic 500. An
    override matching no provider's prefix passes through: the admin
    allowlist and the provider itself are the guards for those. */
export function getAiModelId(
  provider: AiProviderName,
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = env.AI_MODEL?.trim()
  if (!override) return DEFAULT_MODELS[provider]
  const looksLike = providerForModelId(override)
  if (looksLike && looksLike !== provider) {
    throw new MismatchedAiModelError(provider, override, looksLike)
  }
  return override
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
