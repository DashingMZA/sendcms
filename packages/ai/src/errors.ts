// Shared AI error mapping (Phase 16, Wave 8: AIM-004 / AIM-023 /
// SRC-225). The Vercel AI SDK throws raw provider errors
// (AI_APICallError and friends) whose shape the dashboard cannot
// act on: handleApiError collapses any non-ApiError to a generic
// 500, so a bad BYOK key looked identical to a server bug. Every
// capability service maps a model-call failure through
// mapAiCallError before it leaves the service — the client gets a
// 502/503 naming the failure class (never key material, never the
// provider's raw message verbatim when it could echo a key
// fragment), and the raw error stays server-side in the log.
//
// Classification is structural (status code / error name /
// message patterns), never a string match on key material:
// AI_APICallError carries `statusCode` and `responseBody` — the
// classifier reads the status only.
import { ApiError } from "@sendcms/shared"

import type { AiProviderName } from "./provider"

/** Per-call timeouts (SRC-311 / AIM-023): interactive calls fail
    fast (the dashboard proxy gives up after ~30s); worker calls
    (spam re-score, digest) get longer, since the poll loop — not a
    user — is waiting. */
export const AI_INTERACTIVE_TIMEOUT_MS = 25_000
export const AI_WORKER_TIMEOUT_MS = 60_000

/** Output token caps (AIM-023): output length is bounded by the
    call itself, not only by post-hoc Zod validation — an over-long
    reply truncates instead of failing the whole call. */
export const AI_MAX_OUTPUT_TOKENS = {
  /** Spam verdict: a score + one sentence. */
  spam: 300,
  /** Digest: a 2–3 sentence summary + up to 5 highlights. */
  digest: 800,
  /** Reply draft: subject + body, capped at 2000 chars by schema. */
  draft: 1000,
  /** Field suggestions: up to 20 fields with labels/options. */
  formBuilder: 2000,
  /** Key-test probe: a single word. */
  keyTest: 1,
} as const

/** One retry policy for all four capabilities (AIM-023):
    interactive calls already used 1; the worker paths kept the SDK
    default (2). A uniform 1 keeps a hung/overloaded provider from
    burning the caller's budget on backoff, and the worker retries
    the row on a later poll instead. */
export const AI_MAX_RETRIES = 1

export type AiCallFailureKind =
  "auth" | "rate-limit" | "overloaded" | "timeout" | "not-found" | "provider"

export type ClassifiedAiCallError = {
  kind: AiCallFailureKind
  /** HTTP status the client should see. */
  status: number
}

/** Classifies a model-call failure without ever reading key
    material out of it. `statusCode` (AI_APICallError) wins over
    message sniffing; the message patterns only cover SDK errors
    that carry no status (AbortError, plain Errors from the
    provider factories). */
export function classifyAiCallError(err: unknown): ClassifiedAiCallError {
  const status =
    typeof err === "object" && err !== null
      ? ((err as { statusCode?: unknown; status?: unknown }).statusCode ??
        (err as { status?: unknown }).status)
      : undefined
  if (typeof status === "number") {
    if (status === 401 || status === 403) return { kind: "auth", status: 502 }
    if (status === 429) return { kind: "rate-limit", status: 429 }
    if (status === 404 || status === 410)
      return { kind: "not-found", status: 502 }
    if (status === 503 || status === 529)
      return { kind: "overloaded", status: 503 }
    if (status >= 500) return { kind: "provider", status: 502 }
    return { kind: "provider", status: 502 }
  }
  const name =
    typeof err === "object" && err !== null
      ? (err as { name?: unknown }).name
      : undefined
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    (err instanceof Error && /timed out|aborted/i.test(err.message))
  ) {
    return { kind: "timeout", status: 503 }
  }
  const message = err instanceof Error ? err.message : ""
  if (
    /incorrect api key|invalid api key|authentication|unauthorized/i.test(
      message
    )
  ) {
    return { kind: "auth", status: 502 }
  }
  if (/rate limit|too many requests/i.test(message)) {
    return { kind: "rate-limit", status: 429 }
  }
  if (/overloaded|high demand|service unavailable/i.test(message)) {
    return { kind: "overloaded", status: 503 }
  }
  if (/not found|no longer available|retired|does not exist/i.test(message)) {
    return { kind: "not-found", status: 502 }
  }
  return { kind: "provider", status: 502 }
}

/** True only for provider-auth failures (bad/revoked BYOK key,
    wrong platform key) — the one failure class that auto-disables
    a BYOK key (AIM-003). Transient errors (429/5xx/timeout) never
    disable a key. */
export function isAiAuthFailure(err: unknown): boolean {
  return classifyAiCallError(err).kind === "auth"
}

/** Maps a model-call failure to the ApiError the client sees
    (AIM-004 / AIM-023 / SRC-225). Auth failures name the provider
    and point at AI settings; nothing from the provider's message
    is ever returned — it can echo key material (AIM-006). */
export function mapAiCallError(
  err: unknown,
  provider?: AiProviderName
): ApiError {
  if (err instanceof ApiError) return err
  const { kind, status } = classifyAiCallError(err)
  const where = provider ? ` for ${provider}` : ""
  switch (kind) {
    case "auth":
      return new ApiError(
        provider
          ? `Your ${provider} key was rejected by the provider. Check it in AI settings — use the Test button to verify it.`
          : "The AI provider rejected the API key. Check it in AI settings.",
        status
      )
    case "rate-limit":
      return new ApiError(
        `The AI provider${where} is rate-limiting requests. Try again in a minute.`,
        status
      )
    case "overloaded":
      return new ApiError(
        `The AI provider${where} is overloaded right now. Try again later.`,
        status
      )
    case "timeout":
      return new ApiError(
        `The AI provider${where} did not respond in time. Try again later.`,
        status
      )
    case "not-found":
      return new ApiError(
        `The AI model${where} is no longer available. Pick a different model in AI settings.`,
        status
      )
    default:
      return new ApiError(
        `The AI provider${where} failed. Try again later.`,
        status
      )
  }
}
