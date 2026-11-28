import { generateText } from "ai"
import type { AdminSession } from "@sendcms/auth"
import {
  DEFAULT_MODELS,
  MismatchedAiModelError,
  PROVIDER_ENV_VARS,
  UnknownAiProviderError,
  decryptByokKey,
  encryptByokKey,
  getAiModelForKey,
  getAiModelId,
  isAiAuthFailure,
  normalizeAiEnv,
  resolveAiProvider,
  toAiCallUsageWithCost,
  type AiCallUsage,
  type AiEnvConfig,
  type AiProviderName,
} from "@sendcms/ai"
import { AuditAction, AuditResource, db, Prisma } from "@sendcms/database"
import type {
  AiBillingMode,
  AiKeyTestStatus,
  AiProvider,
  AiUsageStatus,
  UserStatus,
} from "@sendcms/database"
import { createLogger } from "@sendcms/observability"
import { requireAdmin } from "@sendcms/permissions"
import { checkLimit, getEffectiveEntitlementsSafe } from "@sendcms/plans"
import type { LimitCheck } from "@sendcms/plans"
import {
  FREE_PLAN_V1_ENTITLEMENTS,
  type PlanEntitlements,
} from "@sendcms/plans/validators"
import { logAudit } from "@sendcms/security"
import { ApiError } from "@sendcms/shared"
import type { LanguageModel } from "ai"
import type {
  AiUsageListQuery,
  AiUsageSummaryQuery,
  SaveAiKeyInput,
} from "./validators"
import { AI_PROVIDER_NAMES } from "./validators"

const logger = createLogger("ai-settings")

// AI provider & BYOK settings (Admin Control Plane, Phase 5).
// Framework-independent (no Next.js imports); only services import
// @sendcms/database. Authorization lives HERE, not in the routes:
// admin functions take the actor's AdminSession first and enforce
// their capability; customer functions take the owner's userId (the
// route's session) and only ever touch that user's rows.
//
// The core invariants:
// - A customer's key is stored ENCRYPTED (envelope encryption, master
//   key in .env outside the DB) — never hashed (a hash could never be
//   used to call a provider) and never plaintext. The plaintext key,
//   the ciphertext, the IV and the tag NEVER leave this service (no
//   API response, no log, no audit record) — only the SHA-256
//   fingerprint's last 4 chars are shown, for matching.
// - Provider resolution NEVER silently falls back BYOK -> platform.
//   A missing, disabled, or failing BYOK key throws a clear error.
//   The only fallback is a STORE-AVAILABILITY fallback: when the
//   settings store itself is unreadable, the mode cannot be known, so
//   the platform default is used (documented in the resolver).
// - One key per provider per user (@@unique([userId, provider])).

// ─── Authorization ────────────────────────────────────────────────────

// The admin gate lives in `@sendcms/permissions` (Phase 16, Wave 2 —
// SRC-215 / SRC-411): one implementation for every module, re-exported
// here so existing import paths keep working.
export { getEffectiveRole, requireAdmin } from "@sendcms/permissions"

// ─── Provider mapping ─────────────────────────────────────────────────

// The API speaks lowercase provider names (openai, anthropic, ...);
// the database enum is uppercase (OPENAI, ANTHROPIC, ...). The AAD
// binding in the envelope encryption uses the LOWERCASE name —
// encrypt and decrypt must use the same form.
export const PROVIDER_NAME_TO_ENUM: Record<AiProviderName, AiProvider> = {
  openai: "OPENAI",
  anthropic: "ANTHROPIC",
  google: "GOOGLE",
  deepseek: "DEEPSEEK",
  openrouter: "OPENROUTER",
}

export const PROVIDER_ENUM_TO_NAME: Record<AiProvider, AiProviderName> = {
  OPENAI: "openai",
  ANTHROPIC: "anthropic",
  GOOGLE: "google",
  DEEPSEEK: "deepseek",
  OPENROUTER: "openrouter",
}

/** AI is not available for this user/request — a clean denial (no
    key, disabled, plan forbids, suspended, provider off), never a
    reason to silently fall back to another key. Always 503: the
    caller degrades to the non-AI behavior (worker) or reports it
    (interactive). */
export class AiNotAvailableError extends ApiError {
  constructor(message: string) {
    super(message, 503)
  }
}

// ─── BYOK keys (customer) ─────────────────────────────────────────────

// What any key list/detail may show. No plaintext, no ciphertext, no
// IV, no tag — only the fingerprint's last 4 chars, for matching.
const keyMetaSelect = {
  id: true,
  userId: true,
  provider: true,
  model: true,
  isEnabled: true,
  keyVersion: true,
  authFailureCount: true,
  lastTestedAt: true,
  lastTestStatus: true,
  keyFingerprint: true,
} as const

export type UserAiKeyMeta = {
  id: string
  userId: string
  provider: AiProviderName
  model: string | null
  isEnabled: boolean
  keyVersion: number
  /** Consecutive provider-auth failures at call time (AIM-003);
      the key auto-disables at AI_BYOK_AUTO_DISABLE_AFTER. */
  authFailureCount: number
  lastTestedAt: Date | null
  lastTestStatus: AiKeyTestStatus
  fingerprintLast4: string
}

type UserAiKeyMetaRow = {
  id: string
  userId: string
  provider: AiProvider
  model: string | null
  isEnabled: boolean
  keyVersion: number
  authFailureCount?: number
  lastTestedAt: Date | null
  lastTestStatus: AiKeyTestStatus
  keyFingerprint: string
}

function toUserAiKeyMeta(row: UserAiKeyMetaRow): UserAiKeyMeta {
  return {
    id: row.id,
    userId: row.userId,
    provider: PROVIDER_ENUM_TO_NAME[row.provider],
    model: row.model,
    isEnabled: row.isEnabled,
    keyVersion: row.keyVersion,
    // Rows written before the Wave 8 migration have no column in
    // the mock DBs the tests use — default to 0, never undefined.
    authFailureCount: row.authFailureCount ?? 0,
    lastTestedAt: row.lastTestedAt,
    lastTestStatus: row.lastTestStatus,
    // Last 4 hex chars of the SHA-256 fingerprint — display only, it
    // can never be reversed into the key.
    fingerprintLast4: row.keyFingerprint.slice(-4),
  }
}

async function getUserOrThrow(userId: string): Promise<{
  id: string
  // DOC-003: the Prisma UserStatus type, not a hardcoded union — the
  // enum gained PENDING_APPROVAL and a literal union would break on
  // every future value. A pending user cannot reach here anyway (no
  // session is ever minted for a non-ACTIVE account).
  status: UserStatus
}> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, status: true },
  })
  if (!user) throw new ApiError("User not found", 404)
  return user
}

function assertNotSuspended(user: { status: string }): void {
  if (user.status === "SUSPENDED" || user.status === "DISABLED") {
    throw new ApiError("AI is not available for a suspended account.", 403)
  }
}

/** Saves (or replaces) one key per provider. Replacing increments
    keyVersion, re-enables the key, and resets the test status — the
    new key has not been tested yet. A save never tests the key
    (testing is the separate Test-button action). Audit records only
    the provider + fingerprint last4 — never key material.
    AIM-025 (provider-terms gate, ADR 0010 Decision 4): saving a
    server-side key requires an explicit terms acknowledgement —
    the caller confirms they have read the provider's
    data-processing / no-training terms. Without it the save is
    refused (422); "Browser only" storage needs no acknowledgement
    because nothing is sent to the server. The master-key error is
    an ApiError 503 from getByokMasterKey (ADM-061 / DSH-301) — it
    propagates unchanged, never wrapped into a generic 500. */
export async function saveUserAiKey(
  userId: string,
  input: SaveAiKeyInput
): Promise<UserAiKeyMeta> {
  const user = await getUserOrThrow(userId)
  assertNotSuspended(user)
  if (input.termsAcknowledged !== true) {
    throw new ApiError(
      "Saving a key on the server requires acknowledging the provider's data-processing terms first — the acknowledgement checkbox is on the save form. (Or choose “Browser only”: the key then stays in your browser and is never sent to the server.)",
      422
    )
  }
  // The plan's provider allowlist applies at save time too: a key for
  // a provider the plan forbids could never resolve, so saving it
  // would only confuse. A failed entitlements lookup falls back to
  // the Free defaults (all providers allowed) — fail-open, as in
  // Phase 4.
  const effective = await getEffectiveEntitlementsSafe(userId)
  const entitlements = effective?.entitlements ?? FREE_PLAN_V1_ENTITLEMENTS
  if (!entitlements.aiProviders.includes(input.provider)) {
    throw new ApiError(
      `Your plan does not allow the ${input.provider} provider.`,
      403
    )
  }
  const encrypted = encryptByokKey(input.apiKey, {
    userId,
    provider: input.provider,
  })
  // SRC-206 / DB-028: create-or-replace is a single atomic upsert on
  // the (userId, provider) unique — the old findUnique → create /
  // update raced (two concurrent saves could both try to create, and
  // both read version N and both write N+1, losing an increment).
  // The update arm increments the version atomically. The pre-read
  // below exists ONLY to label the audit row CREATE vs UPDATE; it is
  // advisory, and a race there can mislabel the audit action, never
  // the data.
  const preExisting = await db.userAiKey.findUnique({
    where: {
      userId_provider: {
        userId,
        provider: PROVIDER_NAME_TO_ENUM[input.provider],
      },
    },
    select: { id: true },
  })
  const row = await db.userAiKey.upsert({
    where: {
      userId_provider: {
        userId,
        provider: PROVIDER_NAME_TO_ENUM[input.provider],
      },
    },
    create: {
      userId,
      provider: PROVIDER_NAME_TO_ENUM[input.provider],
      ...encrypted,
      model: input.model ?? null,
    },
    update: {
      ...encrypted,
      // A provided model replaces the old one; omitting it keeps
      // the previous choice (Prisma skips undefined fields).
      model: input.model,
      isEnabled: true,
      keyVersion: { increment: 1 },
      // A replaced key is a new key: the old key's auth-failure
      // streak must not auto-disable its replacement (AIM-003).
      authFailureCount: 0,
      lastTestStatus: "UNTESTED",
      lastTestedAt: null,
    },
    select: keyMetaSelect,
  })
  await logAudit({
    userId,
    action: preExisting ? AuditAction.UPDATE : AuditAction.CREATE,
    resourceType: AuditResource.AI_KEY,
    resourceId: row.id,
    detail: {
      event: "byok-key-saved",
      provider: input.provider,
      fingerprintLast4: row.keyFingerprint.slice(-4),
    },
  })
  return toUserAiKeyMeta(row)
}

/** Metadata only — never key material. */
export async function listUserAiKeys(userId: string): Promise<UserAiKeyMeta[]> {
  const rows = await db.userAiKey.findMany({
    where: { userId },
    select: keyMetaSelect,
    orderBy: { provider: "asc" },
  })
  return rows.map(toUserAiKeyMeta)
}

/** Metadata only — never key material. */
export async function getUserAiKey(
  userId: string,
  provider: AiProviderName
): Promise<UserAiKeyMeta> {
  const row = await db.userAiKey.findUnique({
    where: {
      userId_provider: {
        userId,
        provider: PROVIDER_NAME_TO_ENUM[provider],
      },
    },
    select: keyMetaSelect,
  })
  if (!row) throw new ApiError(`No ${provider} key saved.`, 404)
  return toUserAiKeyMeta(row)
}

async function setUserAiKeyEnabled(
  userId: string,
  provider: AiProviderName,
  isEnabled: boolean
): Promise<UserAiKeyMeta> {
  const row = await db.userAiKey.findUnique({
    where: {
      userId_provider: {
        userId,
        provider: PROVIDER_NAME_TO_ENUM[provider],
      },
    },
    select: { id: true, keyFingerprint: true },
  })
  if (!row) throw new ApiError(`No ${provider} key saved.`, 404)
  const updated = await db.userAiKey.update({
    where: { id: row.id },
    data: { isEnabled },
    select: keyMetaSelect,
  })
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.AI_KEY,
    resourceId: row.id,
    detail: {
      event: isEnabled ? "byok-key-enabled" : "byok-key-disabled",
      provider,
      fingerprintLast4: row.keyFingerprint.slice(-4),
    },
  })
  return toUserAiKeyMeta(updated)
}

export async function enableUserAiKey(
  userId: string,
  provider: AiProviderName
): Promise<UserAiKeyMeta> {
  return setUserAiKeyEnabled(userId, provider, true)
}

export async function disableUserAiKey(
  userId: string,
  provider: AiProviderName
): Promise<UserAiKeyMeta> {
  return setUserAiKeyEnabled(userId, provider, false)
}

export async function deleteUserAiKey(
  userId: string,
  provider: AiProviderName
): Promise<void> {
  const row = await db.userAiKey.findUnique({
    where: {
      userId_provider: {
        userId,
        provider: PROVIDER_NAME_TO_ENUM[provider],
      },
    },
    select: { id: true, keyFingerprint: true },
  })
  if (!row) throw new ApiError(`No ${provider} key saved.`, 404)
  await db.userAiKey.delete({ where: { id: row.id } })
  await logAudit({
    userId,
    action: AuditAction.DELETE,
    resourceType: AuditResource.AI_KEY,
    resourceId: row.id,
    detail: {
      event: "byok-key-deleted",
      provider,
      fingerprintLast4: row.keyFingerprint.slice(-4),
    },
  })
}

// ─── BYOK key auto-disable on call-time auth failure (AIM-003) ──

// Consecutive provider-auth failures before the key auto-disables.
// 3 is small enough to stop a bad key burning failed calls within
// a day, large enough that one bad probe (e.g. a provider blip
// misclassified as auth) cannot kill a good key. Re-enabling is a
// deliberate user action (enableUserAiKey); saving a new key resets
// the counter.
export const AI_BYOK_AUTO_DISABLE_AFTER = 3

/** Records one provider-AUTH failure for a stored BYOK key at call
    time (suggest-fields, draft-reply, rescore, digest, key-test).
    Increments the consecutive-failure counter, marks lastTestStatus
    FAILED, and auto-disables the key at the threshold with an audit
    event — so a bad key stops burning a live provider call on every
    subsequent request. Best-effort: it NEVER throws (a failed
    bookkeeping write must not mask the call's own result). Only
    auth failures call this — transient errors (429/5xx/timeout)
    must never disable a key; callers classify with
    isAiAuthFailure first. */
export async function recordByokAuthFailure(
  userId: string,
  provider: AiProviderName
): Promise<void> {
  try {
    const row = await db.userAiKey.findUnique({
      where: {
        userId_provider: {
          userId,
          provider: PROVIDER_NAME_TO_ENUM[provider],
        },
      },
      select: { id: true, keyFingerprint: true, authFailureCount: true },
    })
    if (!row) return
    const failures = (row.authFailureCount ?? 0) + 1
    const autoDisabled = failures >= AI_BYOK_AUTO_DISABLE_AFTER
    await db.userAiKey.update({
      where: { id: row.id },
      data: {
        authFailureCount: failures,
        lastTestedAt: new Date(),
        lastTestStatus: "FAILED",
        ...(autoDisabled ? { isEnabled: false } : {}),
      },
    })
    if (autoDisabled) {
      await logAudit({
        userId,
        action: AuditAction.UPDATE,
        resourceType: AuditResource.AI_KEY,
        resourceId: row.id,
        detail: {
          event: "byok-key-auto-disabled",
          provider,
          consecutiveAuthFailures: failures,
          fingerprintLast4: row.keyFingerprint.slice(-4),
        },
      })
    }
  } catch (err) {
    logger.error("byok auth failure recording failed", {
      error: err,
      userId,
      provider,
    })
  }
}

/** Resets the consecutive-auth-failure counter after a successful
    call with a stored BYOK key (AIM-003: the counter is
    CONSECUTIVE, so one good call clears the streak). Best-effort:
    never throws. */
export async function recordByokAuthSuccess(
  userId: string,
  provider: AiProviderName
): Promise<void> {
  try {
    await db.userAiKey.updateMany({
      where: {
        userId,
        provider: PROVIDER_NAME_TO_ENUM[provider],
        authFailureCount: { gt: 0 },
      },
      data: { authFailureCount: 0 },
    })
  } catch (err) {
    logger.error("byok auth success recording failed", {
      error: err,
      userId,
      provider,
    })
  }
}

// ─── Daily AI budget claim (AIM-028 / SRC-218) ────────────────────

// The owner's daily AI budget (aiRequestsPerDay) is ONE budget
// shared by the worker rescore path (per-form AiDailyUsage rows)
// and the interactive paths (per-owner AiDailyOwnerUsage rows).
// A claim sums BOTH counters for today and increments the row for
// the caller's path — under one advisory lock on (owner, day), so
// two concurrent polls (worker + cron) or two interactive calls
// cannot both spend the last unit (SRC-218: the old rescore code
// read the counter, called the model, then incremented — the cap
// was exceeded by the concurrency factor). A claimed unit is
// consumed even when the model call then fails — a down provider
// cannot retry the same rows unboundedly on every poll. Returns
// false when the owner's budget is exhausted (or the cap is 0).
export async function claimAiCall(
  ownerId: string | undefined,
  opts: { formId?: string; cap: number; today?: Date }
): Promise<boolean> {
  const cap = opts.cap
  if (cap <= 0) return false
  const today = opts.today ?? startOfUtcDay(new Date())
  const lockKey = `ai-daily:${ownerId ?? `form:${opts.formId ?? "unknown"}`}:${today.toISOString().slice(0, 10)}`
  return db.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(727001, hashtext(${lockKey}))`
    )
    const formIds = ownerId
      ? (
          await tx.form.findMany({
            where: { ownerId },
            select: { id: true },
          })
        ).map((f) => f.id)
      : opts.formId
        ? [opts.formId]
        : []
    const [formRows, ownerRows] = await Promise.all([
      formIds.length > 0
        ? tx.aiDailyUsage.findMany({
            where: { formId: { in: formIds }, date: today },
            select: { calls: true },
          })
        : Promise.resolve([] as { calls: number }[]),
      ownerId
        ? tx.aiDailyOwnerUsage.findMany({
            where: { userId: ownerId, date: today },
            select: { calls: true },
          })
        : Promise.resolve([] as { calls: number }[]),
    ])
    const used =
      formRows.reduce((sum, r) => sum + r.calls, 0) +
      ownerRows.reduce((sum, r) => sum + r.calls, 0)
    if (used >= cap) return false
    if (opts.formId) {
      await tx.aiDailyUsage.upsert({
        where: { formId_date: { formId: opts.formId, date: today } },
        create: { formId: opts.formId, date: today, calls: 1 },
        update: { calls: { increment: 1 } },
      })
    } else if (ownerId) {
      await tx.aiDailyOwnerUsage.upsert({
        where: { userId_date: { userId: ownerId, date: today } },
        create: { userId: ownerId, date: today, calls: 1 },
        update: { calls: { increment: 1 } },
      })
    } else {
      return false
    }
    return true
  })
}

/** UTC midnight starting the day `at` falls on — the AiDailyUsage /
    AiDailyOwnerUsage bucket. */
export function startOfUtcDay(at: Date = new Date()): Date {
  const day = new Date(at)
  day.setUTCHours(0, 0, 0, 0)
  return day
}

// Default interactive daily cap when the entitlements lookup fails
// (same 100 as the rescore path's DEFAULT_AI_DAILY_CALL_CAP — a
// plans-module error must never stop interactive AI, nor grant
// unlimited calls).
export const DEFAULT_INTERACTIVE_AI_DAILY_CAP = 100

/** Claims one unit of an owner's daily AI budget for an
    interactive call (suggest-fields, draft-reply, key-test —
    AIM-028). The cap is the owner's aiRequestsPerDay from their
    effective plan; a suspended owner has null entitlements → cap 0
    (refused). Returns false when the budget is exhausted — the
    caller answers 429 and writes no usage row for the refused call. */
export async function claimInteractiveAiCall(
  userId: string,
  opts: { cap?: number } = {}
): Promise<boolean> {
  let cap = opts.cap
  if (cap === undefined) {
    const effective = await getEffectiveEntitlementsSafe(userId)
    cap =
      effective === null
        ? DEFAULT_INTERACTIVE_AI_DAILY_CAP
        : effective.entitlements
          ? (effective.entitlements.aiRequestsPerDay ??
            DEFAULT_INTERACTIVE_AI_DAILY_CAP)
          : 0
  }
  return claimAiCall(userId, { cap })
}

// ─── Test button ──────────────────────────────────────────────────────

export type AiKeyTestResult = {
  ok: boolean
  latencyMs: number
  model: string
  error?: string
  /** AIM-001: true when the probe failed on the 25 s timeout. */
  timedOut?: boolean
}

// ─── Key-test error sanitisation (AIM-006) ──────────────────────────
// A provider's auth error echoes part of the tested key (OpenAI's own
// redaction still shows the first ~8 + last 4 chars). The Test-button
// response AND the structured log must never carry key material: only
// the fingerprint's last 4 chars are shown anywhere else in this
// module. So a probe failure is mapped to a short allowlisted
// message — nothing from the provider's message is ever returned or
// logged. The scrub step runs first as belt-and-braces (a provider
// could echo a different fragment tomorrow): any token that appears
// in the key is dropped before classification, so the classifier only
// ever sees safe words.
const KEY_TEST_ERROR_MESSAGES: { pattern: RegExp; message: string }[] = [
  {
    pattern: /incorrect api key|invalid api key|authentication/i,
    message: "Incorrect API key.",
  },
  {
    pattern: /rate limit|too many requests/i,
    message: "Rate limit exceeded. Try again later.",
  },
  // AIM-001: a timed-out probe is a distinct, user-actionable error —
  // not the generic "Key test failed." The 25 s probe timeout surfaces
  // as a TimeoutError whose message matches this pattern.
  {
    pattern: /timed out|timeout/i,
    message: "The provider timed out. Try again later.",
  },
  {
    pattern: /overloaded|currently experiencing high demand/i,
    message: "The provider is overloaded. Try again later.",
  },
]

export function sanitizeKeyTestError(message: string, apiKey: string): string {
  const scrubbed = message
    .split(/(\s+)/)
    .map((token) => {
      const bare = token.replace(/[^A-Za-z0-9_-]/g, "")
      return bare.length >= 4 && apiKey.includes(bare) ? "[redacted]" : token
    })
    .join("")
  for (const { pattern, message: safe } of KEY_TEST_ERROR_MESSAGES) {
    if (pattern.test(scrubbed)) return safe
  }
  return "Key test failed."
}

/** One live probe of a raw API key: a single-token generateText
    call that proves the key works for this provider. A list-models
    call would need a second, provider-specific client per provider;
    generateText works for all five through the one AI SDK. Cost is a
    few tokens. The key is used for this one call only — it is never
    stored or logged here; the caller decides what to record. */

// AIM-001 / SRC-311: the probe's own timeout bound. The request's
// abort signal (passed in by the caller) can cut it shorter.
export const AI_KEY_PROBE_TIMEOUT_MS = 25_000
async function probeKey(
  provider: AiProviderName,
  apiKey: string,
  modelId: string,
  // AIM-001: the caller's request signal — a client disconnect aborts
  // the probe instead of letting it burn the full 25 s timeout.
  options: { signal?: AbortSignal } = {}
): Promise<{
  ok: boolean
  latencyMs: number
  model: string
  error?: string
  /** True when the probe failed on provider auth (AIM-003) — the
      caller feeds that back to the stored key row. The sanitised
      error string alone cannot carry the classification. */
  authFailure?: boolean
  /** AIM-001: true when the 25 s probe timeout fired. */
  timedOut: boolean
  /** AIM-001: true when the caller's request signal aborted. */
  aborted: boolean
  usage: AiCallUsage | null
}> {
  const started = Date.now()
  try {
    const model = getAiModelForKey(provider, apiKey, modelId)
    const result = await generateText({
      model,
      prompt: "Reply with the single word: ok",
      maxOutputTokens: 1,
      // SRC-311: a hung probe used to block the Test button until
      // the proxy gave up (AIM-001's live 85 s evidence).
      // AIM-001: the timeout is combined with the request's abort
      // signal — whichever fires first cancels the probe.
      abortSignal: options.signal
        ? AbortSignal.any([
            AbortSignal.timeout(AI_KEY_PROBE_TIMEOUT_MS),
            options.signal,
          ])
        : AbortSignal.timeout(AI_KEY_PROBE_TIMEOUT_MS),
    })
    return {
      ok: true,
      latencyMs: Date.now() - started,
      model: modelId,
      timedOut: false,
      aborted: false,
      usage: toAiCallUsageWithCost(modelId, result.usage),
    }
  } catch (err) {
    // Sanitised (AIM-006): a provider error can echo part of the key
    // — the raw message never leaves this function.
    const timedOut = err instanceof Error && err.name === "TimeoutError"
    const aborted =
      options.signal?.aborted === true ||
      (err instanceof Error && err.name === "AbortError")
    return {
      ok: false,
      latencyMs: Date.now() - started,
      model: modelId,
      error: sanitizeKeyTestError(
        err instanceof Error ? err.message : "Key test failed.",
        apiKey
      ),
      authFailure: isAiAuthFailure(err),
      timedOut,
      aborted,
      usage: null,
    }
  }
}

// A key test resolves a model for a live probe call, so it obeys the
// same gate as resolveAiModelForUser (owner decision 2026-11-24,
// AIM-005/AIM-020): a DISABLED billing mode or a suspended/disabled
// account resolves no model at all — including a probe.
async function assertAiTestAllowed(userId: string): Promise<void> {
  const user = await getUserOrThrow(userId)
  if (user.status === "SUSPENDED" || user.status === "DISABLED") {
    throw new AiNotAvailableError("AI is not available for this account.")
  }
  if ((await getUserAiBillingMode(userId)) === "DISABLED") {
    throw new AiNotAvailableError("AI is disabled for this account.")
  }
}

/** Tests one saved key with the smallest live call that proves it
    works. A failed test NEVER falls back to the platform key — the
    result is the failure, and the caller shows it. The usage record
    (key-test, BYOK) is written either way. */
export async function testUserAiKey(
  userId: string,
  provider: AiProviderName,
  // AIM-001: the request's abort signal — a client disconnect cancels
  // the probe and suppresses the usage write (below).
  options: { signal?: AbortSignal } = {}
): Promise<AiKeyTestResult> {
  // AIM-001: a disconnected client gets no usage row — the probe's
  // FAILED row would otherwise be written for a test nobody sees,
  // and a retry would double-count it.
  const disconnected = () => options.signal?.aborted === true
  await assertAiTestAllowed(userId)
  const row = await db.userAiKey.findUnique({
    where: {
      userId_provider: {
        userId,
        provider: PROVIDER_NAME_TO_ENUM[provider],
      },
    },
  })
  if (!row) throw new ApiError(`No ${provider} key saved.`, 404)
  const modelId = row.model ?? DEFAULT_MODELS[provider]
  // Decrypt first: a key that cannot be decrypted is a failed test,
  // never a reason to try the platform key. The AAD binds the
  // lowercase provider name (see the mapping above). The master key
  // is selected by the row's recorded version (SRC-314).
  let apiKey: string
  try {
    apiKey = decryptByokKey({
      userId: row.userId,
      provider,
      encryptedKey: row.encryptedKey,
      encryptedDek: row.encryptedDek,
      keyIv: row.keyIv,
      keyTag: row.keyTag,
      masterKeyVersion: row.masterKeyVersion,
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : "Key test failed."
    logger.warn("byok key test failed", { userId, provider, error })
    await db.userAiKey
      .update({
        where: { id: row.id },
        data: { lastTestedAt: new Date(), lastTestStatus: "FAILED" },
      })
      .catch((updateErr: unknown) =>
        logger.error("byok key test status update failed", {
          error: updateErr,
          userId,
          provider,
        })
      )
    // AIM-001: no usage row for a test the client already abandoned.
    if (!disconnected()) {
      await recordAiUsage({
        userId,
        provider,
        model: modelId,
        billingMode: "BYOK",
        status: "FAILED",
        sourceEvent: "key-test",
        resourceId: row.id,
      })
    }
    return { ok: false, latencyMs: 0, model: modelId, error }
  }
  // AIM-028: a key test is a billable model call — it counts toward
  // the owner's daily AI budget like any interactive call. The
  // per-minute route limiter (5/min) caps bursts; this caps the day.
  // Claimed after the decrypt (a 404/decrypt failure consumes
  // nothing) and before the probe.
  if (!(await claimInteractiveAiCall(userId))) {
    throw new ApiError(
      "You have reached your daily AI limit. Try again tomorrow.",
      429
    )
  }
  const probe = await probeKey(provider, apiKey, modelId, {
    signal: options.signal,
  })
  // AIM-001: the probe tells us whether the CLIENT abandoned it
  // (aborted, not timed out) — the request signal alone cannot: a
  // caller-passed timeout signal is aborted too, but a timeout is a
  // real probe outcome that still gets its usage row.
  const probeDisconnected = probe.aborted && !probe.timedOut
  if (!probe.ok) {
    // The log carries the sanitised probe error plus the fingerprint
    // last4 (AIM-006) — never key material.
    logger.warn("byok key test failed", {
      userId,
      provider,
      error: probe.error,
      fingerprintLast4: row.keyFingerprint.slice(-4),
    })
    // AIM-003: a probe that fails on provider auth feeds the
    // auto-disable counter — the Test button is a call-time failure
    // too. Transient failures do not count.
    // AIM-001: a disconnect is neither — no auth-failure bookkeeping
    // for a probe the client abandoned.
    if (probe.authFailure && !probeDisconnected) {
      await recordByokAuthFailure(userId, provider)
    }
  } else {
    await recordByokAuthSuccess(userId, provider)
  }
  // Best-effort: a failed status write must not hide the test result.
  try {
    await db.userAiKey.update({
      where: { id: row.id },
      data: {
        lastTestedAt: new Date(),
        lastTestStatus: probe.ok ? "OK" : "FAILED",
      },
    })
  } catch (err) {
    logger.error("byok key test status update failed", {
      error: err,
      userId,
      provider,
    })
  }
  // AIM-001: skip the usage write when the client disconnected —
  // at most one FAILED row per test invocation, and none for a test
  // nobody is waiting on.
  if (!probeDisconnected) {
    await recordAiUsage({
      userId,
      provider,
      model: modelId,
      billingMode: "BYOK",
      status: probe.ok ? "SUCCESS" : "FAILED",
      tokensIn: probe.usage?.promptTokens ?? null,
      tokensOut: probe.usage?.completionTokens ?? null,
      costMicros: probe.usage?.costMicros ?? null,
      sourceEvent: "key-test",
      resourceId: row.id,
    })
  }
  return {
    ok: probe.ok,
    latencyMs: probe.latencyMs,
    model: modelId,
    ...(probe.error ? { error: probe.error } : {}),
    timedOut: probe.timedOut,
  }
}

/** Tests a raw key the user holds in their browser ("Browser only"
    storage) with the same one-token live probe. The key is used for
    this one call and NEVER stored, logged, or written to any row —
    only the usage record (key-test, BYOK, no resourceId) is kept, so
    the test is attributed without keeping the key. A failed test
    NEVER falls back to the platform key. */
export async function testBrowserKey(
  userId: string,
  provider: AiProviderName,
  apiKey: string,
  model?: string,
  // AIM-001: the request's abort signal — see testUserAiKey.
  options: { signal?: AbortSignal } = {}
): Promise<AiKeyTestResult> {
  await assertAiTestAllowed(userId)
  if (typeof apiKey !== "string" || apiKey.trim().length < 8) {
    throw new ApiError("A valid API key is required to test it.", 422)
  }
  // AIM-028: a browser-key test is a billable model call too — but
  // only a VALID key claims budget (a 422 for a too-short key
  // consumes nothing).
  if (!(await claimInteractiveAiCall(userId))) {
    throw new ApiError(
      "You have reached your daily AI limit. Try again tomorrow.",
      429
    )
  }
  const modelId = model?.trim() || DEFAULT_MODELS[provider]
  const probe = await probeKey(provider, apiKey.trim(), modelId, {
    signal: options.signal,
  })
  // AIM-001: aborted-by-the-client (not timed out) — see testUserAiKey.
  const probeDisconnected = probe.aborted && !probe.timedOut
  if (!probe.ok) {
    // Sanitised by probeKey (AIM-006) — never key material.
    logger.warn("browser key test failed", {
      userId,
      provider,
      error: probe.error,
    })
  }
  // AIM-001: skip the usage write when the client disconnected.
  if (!probeDisconnected) {
    await recordAiUsage({
      userId,
      provider,
      model: modelId,
      billingMode: "BYOK",
      status: probe.ok ? "SUCCESS" : "FAILED",
      tokensIn: probe.usage?.promptTokens ?? null,
      tokensOut: probe.usage?.completionTokens ?? null,
      costMicros: probe.usage?.costMicros ?? null,
      sourceEvent: "key-test",
    })
  }
  return {
    ok: probe.ok,
    latencyMs: probe.latencyMs,
    model: modelId,
    ...(probe.error ? { error: probe.error } : {}),
    timedOut: probe.timedOut,
  }
}

// ─── Billing mode ─────────────────────────────────────────────────────

export async function getUserAiBillingMode(
  userId: string
): Promise<AiBillingMode> {
  const row = await db.userAiSettings.findUnique({
    where: { userId },
    select: { billingMode: true },
  })
  return row?.billingMode ?? "PLATFORM"
}

type EffectiveEntitlementsShape = PlanEntitlements

async function validateBillingMode(
  userId: string,
  mode: AiBillingMode
): Promise<void> {
  // DISABLED is always allowed — even for a suspended account, an
  // admin may want to turn AI off. BYOK/PLATFORM are not.
  if (mode === "DISABLED") return
  const user = await getUserOrThrow(userId)
  assertNotSuspended(user)
  const effective = await getEffectiveEntitlementsSafe(userId)
  const entitlements: EffectiveEntitlementsShape =
    effective?.entitlements ?? FREE_PLAN_V1_ENTITLEMENTS
  if (mode === "BYOK" && !entitlements.aiByokAllowed) {
    throw new ApiError(
      "Your plan does not allow BYOK. Ask an admin to upgrade your plan.",
      403
    )
  }
  if (mode === "PLATFORM" && !entitlements.aiPlatformAllowed) {
    throw new ApiError("Your plan does not allow platform AI.", 403)
  }
}

/** BYOK pauses the platform key for this user — that is exactly what
    the mode means, no separate paused flag. Re-enabling PLATFORM
    resumes it. */
// DB-051: the previous mode is read under a row lock in the same
// transaction as the write, so a concurrent change cannot make the
// audit's old value stale. A missing row locks nothing, but the upsert
// then creates it — and the previous value is PLATFORM either way
// (the column default).
async function setBillingModeLocked(
  userId: string,
  mode: AiBillingMode
): Promise<AiBillingMode> {
  return db.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ billingMode: AiBillingMode }[]>`
        SELECT "billingMode" FROM "UserAiSettings" WHERE "userId" = ${userId} FOR UPDATE
      `
      const previous = locked.length > 0 ? locked[0].billingMode : "PLATFORM"
      await tx.userAiSettings.upsert({
        where: { userId },
        create: { userId, billingMode: mode },
        update: { billingMode: mode },
      })
      return previous
    },
    { maxWait: 20000, timeout: 30000 }
  )
}

export async function setUserAiBillingMode(
  userId: string,
  mode: AiBillingMode
): Promise<AiBillingMode> {
  await validateBillingMode(userId, mode)
  const previous = await setBillingModeLocked(userId, mode)
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: {
      event: "ai-billing-mode-changed",
      billingMode: mode,
      previousBillingMode: previous,
    },
  })
  return mode
}

export async function setUserAiBillingModeForAdmin(
  actor: AdminSession,
  userId: string,
  mode: AiBillingMode
): Promise<AiBillingMode> {
  requireAdmin(actor, "MANAGE_AI")
  await validateBillingMode(userId, mode)
  const previous = await setBillingModeLocked(userId, mode)
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: {
      event: "ai-billing-mode-changed",
      billingMode: mode,
      previousBillingMode: previous,
      targetUserId: userId,
    },
  })
  return mode
}

// ─── Usage recording ──────────────────────────────────────────────────

export type RecordAiUsageInput = {
  userId: string
  provider: AiProviderName
  model: string
  billingMode: AiBillingMode
  status: AiUsageStatus
  tokensIn?: number | null
  tokensOut?: number | null
  costMicros?: number | null
  sourceEvent?: string
  resourceId?: string
}

/** Records one AI call for cost attribution. Best-effort: it NEVER
    throws — a failed usage write must not break the capability that
    made the call. costMicros is the price-table cost computed from
    the provider-reported token counts (DB-033); null when the model
    has no price row — never an estimate. */
export async function recordAiUsage(input: RecordAiUsageInput): Promise<void> {
  try {
    await db.aiUsageRecord.create({
      data: {
        userId: input.userId,
        provider: PROVIDER_NAME_TO_ENUM[input.provider],
        model: input.model,
        billingMode: input.billingMode,
        tokensIn: input.tokensIn ?? null,
        tokensOut: input.tokensOut ?? null,
        costMicros: input.costMicros ?? null,
        status: input.status,
        sourceEvent: input.sourceEvent ?? null,
        resourceId: input.resourceId ?? null,
      },
    })
  } catch (err) {
    logger.error("ai usage record failed", {
      error: err,
      userId: input.userId,
      provider: input.provider,
      sourceEvent: input.sourceEvent,
    })
  }
}

// ─── Provider resolution ──────────────────────────────────────────────

export type ResolvedAiModel = {
  model: LanguageModel
  billingMode: "BYOK" | "PLATFORM"
  provider: AiProviderName
  modelId: string
}

export type ResolveAiOptions = {
  provider?: AiProviderName
  purpose: string
  browserKey?: string
  browserModel?: string
  resourceId?: string
  // SRC-123: either a whole environment (legacy callers) or the
  // explicit AiEnvConfig a route built with pickAiEnvConfig — the
  // resolver only ever sees the AI vars, never the ambient env.
  env?: NodeJS.ProcessEnv | AiEnvConfig
}

async function getProviderConfigRow(provider: AiProviderName): Promise<{
  isEnabled: boolean
  allowedModels: string[]
  defaultModel: string | null
} | null> {
  try {
    const row = await db.aiProviderConfig.findUnique({
      where: { provider: PROVIDER_NAME_TO_ENUM[provider] },
      select: { isEnabled: true, allowedModels: true, defaultModel: true },
    })
    if (!row) return null
    const allowedModels = Array.isArray(row.allowedModels)
      ? (row.allowedModels as unknown[]).filter(
          (m): m is string => typeof m === "string"
        )
      : []
    return {
      isEnabled: row.isEnabled,
      allowedModels,
      defaultModel: row.defaultModel,
    }
  } catch (err) {
    // Best-effort: a failed config read must not block AI — the
    // admin config refines access, it never gates it by its absence.
    logger.warn("ai provider config read failed, using defaults", {
      error: err,
      provider,
    })
    return null
  }
}

/** Builds the platform-key model for one provider. Throws
    AiNotAvailableError when the provider is off, unconfigured, or the
    model is not on the admin's allowlist. */
async function resolvePlatformModel(
  provider: AiProviderName,
  env: NodeJS.ProcessEnv,
  opts: { modelId?: string } = {}
): Promise<ResolvedAiModel> {
  const keyVar = PROVIDER_ENV_VARS[provider]
  const apiKey = env[keyVar]
  if (!apiKey) {
    throw new AiNotAvailableError(
      `No AI provider key is configured for ${provider} (${keyVar} is not set).`
    )
  }
  const config = await getProviderConfigRow(provider)
  if (config && !config.isEnabled) {
    throw new AiNotAvailableError(
      `The ${provider} provider is disabled by the administrator.`
    )
  }
  const modelId =
    opts.modelId ?? config?.defaultModel ?? getAiModelId(provider, env)
  if (
    config &&
    config.allowedModels.length > 0 &&
    !config.allowedModels.includes(modelId)
  ) {
    throw new AiNotAvailableError(
      `The model "${modelId}" is not allowed for ${provider}.`
    )
  }
  return {
    model: getAiModelForKey(provider, apiKey, modelId),
    billingMode: "PLATFORM",
    provider,
    modelId,
  }
}

// SRC-202: the pre-BYOK platform path (`resolveAiModelLegacy` +
// `detectProviderFromEnv` + `LEGACY_PROVIDER_ENV_VARS`) used to run
// when the settings store was unreadable (the mode could not be
// known). It is REMOVED: a store error now fails closed with
// AiNotAvailableError in the resolver, so a DISABLED / BYOK-only /
// suspended mode can never be bypassed by a platform-key fallback.

/** Picks the provider for a BYOK-mode call. Throws
    AiNotAvailableError when no usable key exists — never a reason to
    try the platform key. */
function pickByokProvider(
  requested: AiProviderName | undefined,
  keys: { provider: AiProvider; isEnabled: boolean }[],
  env: NodeJS.ProcessEnv
): AiProviderName {
  const enabled = keys
    .filter((k) => k.isEnabled)
    .map((k) => PROVIDER_ENUM_TO_NAME[k.provider])
  if (requested) {
    if (!enabled.includes(requested)) {
      const anyForProvider = keys.some(
        (k) => k.provider === PROVIDER_NAME_TO_ENUM[requested]
      )
      if (anyForProvider) {
        throw new AiNotAvailableError(
          `Your ${requested} key is disabled. Enable it in AI settings first.`
        )
      }
      throw new AiNotAvailableError(
        `No BYOK key saved for ${requested}. Save one in AI settings first.`
      )
    }
    return requested
  }
  // No provider requested: prefer the platform's configured provider
  // when the user has a key for it, else the first enabled key.
  // AIM-024: the swallow here is deliberate — the platform provider
  // is only a preference hint for which BYOK key to prefer, so a
  // bogus AI_PROVIDER must not refuse a call the user's own key can
  // serve. The loud path for a bad AI_PROVIDER is step (3) of
  // resolveAiModelForUser (platform mode) and the rescore gate's
  // getAiProviderConfigError log (worker).
  let platformProvider: AiProviderName | "none" = "none"
  try {
    platformProvider = resolveAiProvider(env)
  } catch {
    platformProvider = "none"
  }
  if (platformProvider !== "none" && enabled.includes(platformProvider)) {
    return platformProvider
  }
  if (enabled.length > 0) return enabled[0]
  throw new AiNotAvailableError(
    "No BYOK key saved. Save one in AI settings first."
  )
}

/** Builds a model from a per-request browser-only key. The key is
    bound to one provider and must never be sent to another. */
function resolveBrowserKeyModel(
  browserKey: string,
  opts: ResolveAiOptions
): ResolvedAiModel {
  const provider = opts.provider
  if (!provider || !AI_PROVIDER_NAMES.includes(provider)) {
    throw new AiNotAvailableError(
      "A browser-only key needs a provider. Pick the provider the key belongs to."
    )
  }
  const modelId = opts.browserModel?.trim() || DEFAULT_MODELS[provider]
  return {
    model: getAiModelForKey(provider, browserKey, modelId),
    billingMode: "BYOK",
    provider,
    modelId,
  }
}

/** The single function every AI capability calls. Precedence:
    (0) the mode / emergency gate — read FIRST (AIM-005 / AIM-020,
    owner decision 2026-11-24): DISABLED wins over every key path,
    including a per-request browser-only key, and the Phase 4
    emergency switch stops every path too — a browser-only key is
    the user's own money, but it is not a bypass around an admin
    disabling AI for the account or for the platform;
    (1) a per-request browser-only key — used for THIS call only via
    getAiModelForKey, never stored, never logged (the "Browser only"
    storage choice; the dashboard keeps it in localStorage and sends
    it per request); (2) billingMode BYOK — the user's stored enabled
    key; a missing, disabled, or unreadable key throws, NEVER
    silently falling back to the platform key; (3) billingMode
    PLATFORM — the platform key via resolvePlatformModel, only when
    the plan allows platform AI, the admin has the provider enabled,
    and the Phase 4 emergency flag is off (the emergency flag is
    folded into the effective entitlements by @sendcms/plans); (4)
    DISABLED or nothing configured — a clear "AI is not available"
    error, so callers degrade to the non-AI behavior. A store error
    while reading the mode fails CLOSED (SRC-202) with
    AiNotAvailableError — never a legacy platform-key fallback.
    Never send a customer's key to a different provider: the key is
    bound to its provider by the crypto AAD and by the lookup.
    The returned { model, billingMode, provider, modelId } lets the
    caller record usage on completion/failure (recordAiUsage). */
export async function resolveAiModelForUser(
  userId: string,
  opts: ResolveAiOptions
): Promise<ResolvedAiModel> {
  const env = normalizeAiEnv(opts.env ?? process.env)

  // (0) Read the user's mode, keys and entitlements FIRST. If the
  // settings store itself is unreadable, FAIL CLOSED (SRC-202): the
  // mode could not be determined, so there is NO safe default — a
  // legacy platform-key fallback here would silently serve AI to a
  // user whose mode may be DISABLED, BYOK-only, or suspended, and
  // would spend the platform key for a call that was never
  // authorized. Callers already degrade on AiNotAvailableError
  // (503), so a store outage degrades AI instead of bypassing the
  // mode gate. Clean ApiErrors (unknown user, suspended account)
  // propagate as-is.
  let mode: AiBillingMode
  let keys: {
    id: string
    userId: string
    provider: AiProvider
    model: string | null
    isEnabled: boolean
    encryptedKey: string
    encryptedDek: string
    keyIv: string
    keyTag: string
    masterKeyVersion: number
  }[]
  let entitlements: EffectiveEntitlementsShape
  let emergency: boolean
  try {
    const user = await getUserOrThrow(userId)
    // A suspended account gets "not available" (503), not a 403:
    // resolution is a capability check, and the callers degrade to
    // the non-AI behavior on a 503. (Direct actions — saving a key,
    // setting a mode — still use the 403 in assertNotSuspended.)
    if (user.status === "SUSPENDED" || user.status === "DISABLED") {
      throw new AiNotAvailableError("AI is not available for this account.")
    }
    const [settings, storedKeys] = await Promise.all([
      db.userAiSettings.findUnique({
        where: { userId },
        select: { billingMode: true },
      }),
      db.userAiKey.findMany({ where: { userId } }),
    ])
    mode = settings?.billingMode ?? "PLATFORM"
    keys = storedKeys
    const effective = await getEffectiveEntitlementsSafe(userId)
    entitlements = effective?.entitlements ?? FREE_PLAN_V1_ENTITLEMENTS
    emergency = effective?.emergency ?? false
  } catch (err) {
    if (err instanceof ApiError) throw err
    logger.warn("ai settings unreadable, failing closed", {
      error: err,
      userId,
      purpose: opts.purpose,
    })
    throw new AiNotAvailableError(
      "AI is not available right now. Please try again later."
    )
  }

  if (emergency) {
    throw new AiNotAvailableError(
      "AI is temporarily disabled by the platform administrator."
    )
  }
  if (mode === "DISABLED") {
    throw new AiNotAvailableError("AI is disabled for this account.")
  }

  // (1) A per-request browser-only key. It needs an explicit provider
  // — the key is bound to one provider and must never be sent to
  // another. It reaches here only after the gate above: a DISABLED
  // mode or the emergency switch has already refused the call.
  // No plan check here: it is reachable only by an authenticated
  // non-suspended user, and it spends the user's own money, not the
  // platform's.
  const browserKey = opts.browserKey?.trim()
  if (browserKey) {
    return resolveBrowserKeyModel(browserKey, opts)
  }

  // (2) BYOK: the user's own key. A missing, disabled, or unreadable
  // key throws — NEVER silently fall back to the platform key.
  if (mode === "BYOK") {
    if (!entitlements.aiByokAllowed) {
      throw new AiNotAvailableError(
        "Your plan does not allow BYOK. Ask an admin to upgrade your plan."
      )
    }
    const provider = pickByokProvider(opts.provider, keys, env)
    if (!entitlements.aiProviders.includes(provider)) {
      throw new AiNotAvailableError(
        `Your plan does not allow the ${provider} provider.`
      )
    }
    const config = await getProviderConfigRow(provider)
    if (config && !config.isEnabled) {
      throw new AiNotAvailableError(
        `The ${provider} provider is disabled by the administrator.`
      )
    }
    const row = keys.find(
      (k) => k.provider === PROVIDER_NAME_TO_ENUM[provider] && k.isEnabled
    )
    if (!row) {
      // pickByokProvider already verified an enabled key exists;
      // this is unreachable in practice, but never fall back.
      throw new AiNotAvailableError(
        `No BYOK key saved for ${provider}. Save one in AI settings first.`
      )
    }
    const modelId = row.model ?? DEFAULT_MODELS[provider]
    let apiKey: string
    try {
      apiKey = decryptByokKey({
        userId: row.userId,
        provider,
        encryptedKey: row.encryptedKey,
        encryptedDek: row.encryptedDek,
        keyIv: row.keyIv,
        keyTag: row.keyTag,
        masterKeyVersion: row.masterKeyVersion,
      })
    } catch (err) {
      // A missing/misconfigured master key is a platform error, not
      // a reason to try the platform key — surface it unchanged.
      if (err instanceof Error && err.message.includes("AI_BYOK_MASTER_KEY")) {
        throw err
      }
      throw new AiNotAvailableError(
        `Your saved ${provider} key could not be read. Save it again in AI settings.`
      )
    }
    return {
      model: getAiModelForKey(provider, apiKey, modelId),
      billingMode: "BYOK",
      provider,
      modelId,
    }
  }

  // (3) PLATFORM: the system's .env key, when the plan allows it.
  if (!entitlements.aiPlatformAllowed) {
    throw new AiNotAvailableError("Your plan does not allow platform AI.")
  }
  // AIM-024 / AIM-027: a bad AI_PROVIDER or a wrong-provider
  // AI_MODEL is a named misconfiguration, not a generic 503 — the
  // resolver's typed errors are converted here so the interactive
  // caller (suggest-fields, draft-reply) reports the bad value
  // instead of "AI is not available right now".
  let provider: AiProviderName | "none"
  try {
    provider = opts.provider ?? resolveAiProvider(env)
  } catch (err) {
    if (err instanceof UnknownAiProviderError) {
      throw new AiNotAvailableError(err.message)
    }
    throw err
  }
  if (provider === "none") {
    throw new AiNotAvailableError(
      "No AI provider is configured. Set a provider key first."
    )
  }
  if (!entitlements.aiProviders.includes(provider)) {
    throw new AiNotAvailableError(
      `Your plan does not allow the ${provider} provider.`
    )
  }
  try {
    return await resolvePlatformModel(provider, env)
  } catch (err) {
    if (err instanceof MismatchedAiModelError) {
      throw new AiNotAvailableError(err.message)
    }
    throw err
  }
}

/** The worker-safe wrapper: null on ANY resolution failure, so the
    worker degrades to the non-AI behavior (skip the AI step) instead
    of crashing. Interactive callers use resolveAiModelForUser and
    surface the error. */
export async function resolveAiModelForUserSafe(
  userId: string,
  opts: ResolveAiOptions
): Promise<ResolvedAiModel | null> {
  try {
    return await resolveAiModelForUser(userId, opts)
  } catch (err) {
    logger.warn("ai resolution failed, degrading to non-AI behavior", {
      error: err,
      userId,
      purpose: opts.purpose,
    })
    return null
  }
}

/** True when any user has any stored BYOK key. Best-effort: false on
    any error. The worker's early gate uses it so a BYOK-only
    deployment (no platform key) still runs its AI jobs. */
export async function anyByokKeyConfigured(): Promise<boolean> {
  try {
    const row = await db.userAiKey.findFirst({ select: { id: true } })
    return row !== null
  } catch (err) {
    logger.warn("byok key existence check failed", { error: err })
    return false
  }
}

// ─── Admin: provider config ───────────────────────────────────────────

export type AiProviderConfigRow = {
  provider: AiProviderName
  isEnabled: boolean
  allowedModels: string[]
  defaultModel: string | null
}

const PROVIDER_DEFAULTS: Record<
  AiProviderName,
  { isEnabled: boolean; allowedModels: string[]; defaultModel: string | null }
> = {
  openai: { isEnabled: true, allowedModels: [], defaultModel: null },
  anthropic: { isEnabled: true, allowedModels: [], defaultModel: null },
  google: { isEnabled: true, allowedModels: [], defaultModel: null },
  deepseek: { isEnabled: true, allowedModels: [], defaultModel: null },
  openrouter: { isEnabled: true, allowedModels: [], defaultModel: null },
}

function toProviderConfigRow(row: {
  provider: AiProvider
  isEnabled: boolean
  allowedModels: unknown
  defaultModel: string | null
}): AiProviderConfigRow {
  return {
    provider: PROVIDER_ENUM_TO_NAME[row.provider],
    isEnabled: row.isEnabled,
    allowedModels: Array.isArray(row.allowedModels)
      ? (row.allowedModels as unknown[]).filter(
          (m): m is string => typeof m === "string"
        )
      : [],
    defaultModel: row.defaultModel,
  }
}

/** All five providers with their config. Missing rows are returned
    from the in-memory defaults — the read is pure. SRC-235: this
    used to `createMany` the missing rows on a GET path, so a read
    could fail on a write error and hid a missing seed. The rows are
    seeded by migration
    (`20261125091400_wave8d_seed_platform_settings`) and created by
    `setProviderConfig` on the first write. */
export async function listProviderConfigs(
  actor: AdminSession
): Promise<AiProviderConfigRow[]> {
  requireAdmin(actor, "MANAGE_AI")
  const rows = await db.aiProviderConfig.findMany({
    orderBy: { provider: "asc" },
  })
  const byProvider = new Map(
    rows.map((r) => [PROVIDER_ENUM_TO_NAME[r.provider], r])
  )
  // Every provider, in registry order: the stored row when one
  // exists, the platform default otherwise (never a write).
  return AI_PROVIDER_NAMES.map((name) => {
    const row = byProvider.get(name)
    if (row) return toProviderConfigRow(row)
    return toProviderConfigRow({
      provider: PROVIDER_NAME_TO_ENUM[name],
      ...PROVIDER_DEFAULTS[name],
    })
  })
}

export type ProviderConfigInput = {
  isEnabled?: boolean
  allowedModels?: string[]
  defaultModel?: string | null
}

export async function setProviderConfig(
  actor: AdminSession,
  provider: AiProviderName,
  input: ProviderConfigInput
): Promise<AiProviderConfigRow> {
  requireAdmin(actor, "MANAGE_AI")
  const data: ProviderConfigInput = {}
  if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled
  if (input.allowedModels !== undefined)
    data.allowedModels = input.allowedModels
  if (input.defaultModel !== undefined) data.defaultModel = input.defaultModel
  // ADM-062: capture the previous row BEFORE the upsert, so the
  // audit record carries what changed — mirroring
  // setUserMcpSettings (old/new), not just {event, provider}.
  const previous = await db.aiProviderConfig.findUnique({
    where: { provider: PROVIDER_NAME_TO_ENUM[provider] },
  })
  const row = await db.aiProviderConfig.upsert({
    where: { provider: PROVIDER_NAME_TO_ENUM[provider] },
    create: {
      provider: PROVIDER_NAME_TO_ENUM[provider],
      isEnabled: data.isEnabled ?? true,
      allowedModels: data.allowedModels ?? [],
      defaultModel: data.defaultModel ?? null,
    },
    update: data,
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.SETTINGS,
    resourceId: row.id,
    detail: {
      event: "ai-provider-config-changed",
      provider,
      old: previous ? toProviderConfigRow(previous) : null,
      new: toProviderConfigRow(row),
    },
  })
  return toProviderConfigRow(row)
}

export type AiProviderHealth = {
  provider: AiProviderName
  isEnabled: boolean
  platformKeyConfigured: boolean
  calls24h: number
  failed24h: number
  errorRate: number | null
}

/** Per-provider health: admin config, whether the platform key is
    set, and the last-24h error rate from usage records — counts only,
    no key material. */
export async function getProviderHealth(
  actor: AdminSession,
  env: NodeJS.ProcessEnv = process.env
): Promise<AiProviderHealth[]> {
  requireAdmin(actor, "MANAGE_AI")
  const configs = await listProviderConfigs(actor)
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const grouped = await db.aiUsageRecord.groupBy({
    by: ["provider", "status"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  })
  return configs.map((config) => {
    const forProvider = grouped.filter(
      (g) => g.provider === PROVIDER_NAME_TO_ENUM[config.provider]
    )
    const total = forProvider.reduce((sum, g) => sum + g._count._all, 0)
    const failed = forProvider
      .filter((g) => g.status === "FAILED")
      .reduce((sum, g) => sum + g._count._all, 0)
    return {
      provider: config.provider,
      isEnabled: config.isEnabled,
      platformKeyConfigured: Boolean(env[PROVIDER_ENV_VARS[config.provider]]),
      calls24h: total,
      failed24h: failed,
      errorRate: total > 0 ? failed / total : null,
    }
  })
}

// ─── Admin: usage reporting ───────────────────────────────────────────

export type AiUsageRow = {
  id: string
  userId: string
  user: { id: string; name: string | null; email: string } | null
  provider: AiProviderName
  model: string
  billingMode: AiBillingMode
  tokensIn: number | null
  tokensOut: number | null
  costMicros: number | null
  status: AiUsageStatus
  sourceEvent: string | null
  resourceId: string | null
  createdAt: Date
}

function usageWhere(
  filters: AiUsageListQuery | AiUsageSummaryQuery
): Prisma.AiUsageRecordWhereInput {
  const where: Prisma.AiUsageRecordWhereInput = {}
  if (filters.userId) where.userId = filters.userId
  if (filters.provider) {
    where.provider = PROVIDER_NAME_TO_ENUM[filters.provider]
  }
  if (filters.billingMode) where.billingMode = filters.billingMode
  if ("status" in filters && filters.status) where.status = filters.status
  if ("sourceEvent" in filters && filters.sourceEvent) {
    where.sourceEvent = filters.sourceEvent
  }
  const createdAt: { gte?: Date; lte?: Date } = {}
  if (filters.from) {
    const d = new Date(filters.from)
    if (!Number.isNaN(d.getTime())) createdAt.gte = d
  }
  if (filters.to) {
    const d = new Date(filters.to)
    if (!Number.isNaN(d.getTime())) createdAt.lte = d
  }
  if (Object.keys(createdAt).length > 0) where.createdAt = createdAt
  return where
}

export async function listAiUsage(
  actor: AdminSession,
  filters: AiUsageListQuery
): Promise<{
  usage: AiUsageRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "VIEW_AI_USAGE")
  const where = usageWhere(filters)
  const [total, rows] = await Promise.all([
    db.aiUsageRecord.count({ where }),
    db.aiUsageRecord.findMany({
      where,
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.perPage,
      take: filters.perPage,
    }),
  ])
  return {
    usage: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      user: r.user,
      provider: PROVIDER_ENUM_TO_NAME[r.provider],
      model: r.model,
      billingMode: r.billingMode,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      costMicros: r.costMicros,
      status: r.status,
      sourceEvent: r.sourceEvent,
      resourceId: r.resourceId,
      createdAt: r.createdAt,
    })),
    total,
    page: filters.page,
    perPage: filters.perPage,
    totalPages: Math.max(1, Math.ceil(total / filters.perPage)),
  }
}

export type AiUsageModeSummary = {
  calls: number
  success: number
  failed: number
  /** RETRY rows (ADM-063): without this bucket success + failed
      never added up to calls. */
  retry: number
  tokensIn: number
  tokensOut: number
  costMicros: number
}

/** Per-model totals over the summary's full window (ADM-065):
    the "models in use" table aggregates these instead of sampling
    the most recent 100 usage rows. */
export type AiUsageModelRow = {
  provider: AiProviderName
  model: string
  calls: number
  success: number
  failed: number
  retry: number
}

export type AiUsageSummary = {
  byok: AiUsageModeSummary
  platform: AiUsageModeSummary
  total: AiUsageModeSummary
  models: AiUsageModelRow[]
}

function emptyModeSummary(): AiUsageModeSummary {
  return {
    calls: 0,
    success: 0,
    failed: 0,
    retry: 0,
    tokensIn: 0,
    tokensOut: 0,
    costMicros: 0,
  }
}

type AiUsageGroupRow = {
  billingMode: AiBillingMode
  status: AiUsageStatus
  _count: { _all: number }
  _sum: {
    tokensIn: number | null
    tokensOut: number | null
    costMicros: number | null
  }
}

type AiUsageModelGroupRow = {
  provider: AiProvider
  model: string
  status: AiUsageStatus
  _count: { _all: number }
}

// One summarizer for the admin getAiUsageSummary and the customer
// getMyAiUsage below: BYOK vs PLATFORM totals, separated — never
// mixed. costMicros counts the price-table cost from
// recordAiUsage (DB-033); it is null for unknown models, never an
// estimate.
function toAiUsageSummary(
  grouped: AiUsageGroupRow[],
  modelGrouped: AiUsageModelGroupRow[] = []
): AiUsageSummary {
  const byMode = new Map<AiBillingMode, AiUsageModeSummary>()
  for (const g of grouped) {
    const bucket = byMode.get(g.billingMode) ?? emptyModeSummary()
    bucket.calls += g._count._all
    if (g.status === "SUCCESS") bucket.success += g._count._all
    if (g.status === "FAILED") bucket.failed += g._count._all
    if (g.status === "RETRY") bucket.retry += g._count._all
    bucket.tokensIn += g._sum.tokensIn ?? 0
    bucket.tokensOut += g._sum.tokensOut ?? 0
    bucket.costMicros += g._sum.costMicros ?? 0
    byMode.set(g.billingMode, bucket)
  }
  const byok = byMode.get("BYOK") ?? emptyModeSummary()
  const platform = byMode.get("PLATFORM") ?? emptyModeSummary()
  const disabled = byMode.get("DISABLED") ?? emptyModeSummary()
  const total: AiUsageModeSummary = {
    calls: byok.calls + platform.calls + disabled.calls,
    success: byok.success + platform.success + disabled.success,
    failed: byok.failed + platform.failed + disabled.failed,
    retry: byok.retry + platform.retry + disabled.retry,
    tokensIn: byok.tokensIn + platform.tokensIn + disabled.tokensIn,
    tokensOut: byok.tokensOut + platform.tokensOut + disabled.tokensOut,
    costMicros: byok.costMicros + platform.costMicros + disabled.costMicros,
  }
  const modelMap = new Map<string, AiUsageModelRow>()
  for (const g of modelGrouped) {
    const key = `${g.provider}:${g.model}`
    const row = modelMap.get(key) ?? {
      provider: PROVIDER_ENUM_TO_NAME[g.provider],
      model: g.model,
      calls: 0,
      success: 0,
      failed: 0,
      retry: 0,
    }
    row.calls += g._count._all
    if (g.status === "SUCCESS") row.success += g._count._all
    if (g.status === "FAILED") row.failed += g._count._all
    if (g.status === "RETRY") row.retry += g._count._all
    modelMap.set(key, row)
  }
  const models = [...modelMap.values()].sort((a, b) => b.calls - a.calls)
  return { byok, platform, total, models }
}

/** BYOK vs PLATFORM totals, separated — never mixed. costMicros
    counts the price-table cost recorded per call (DB-033); it is
    null for unknown models, never an estimate. The `models`
    aggregate covers the summary's full window (ADM-065), so the
    models page no longer samples the most recent 100 rows. */
export async function getAiUsageSummary(
  actor: AdminSession,
  filters: AiUsageSummaryQuery
): Promise<AiUsageSummary> {
  requireAdmin(actor, "VIEW_AI_USAGE")
  const where = usageWhere(filters)
  const [grouped, modelGrouped] = await Promise.all([
    db.aiUsageRecord.groupBy({
      by: ["billingMode", "status"],
      where,
      _count: { _all: true },
      _sum: { tokensIn: true, tokensOut: true, costMicros: true },
    }),
    db.aiUsageRecord.groupBy({
      by: ["provider", "model", "status"],
      where,
      _count: { _all: true },
    }),
  ])
  return toAiUsageSummary(grouped, modelGrouped)
}

// ─── Customer: own AI usage (AIM-014, Wave 6) ─────────────────────────────

// What the customer sees on /dashboard/ai: their AI billing mode, the
// remaining AI allowance for today (the same live count the quota
// check enforces), today's calls split BYOK vs platform, and the
// provider-reported cost. Owner-scoped by construction — the only
// input is the caller's userId. This MUST NOT reuse the admin
// getAiUsageSummary (SEC-101 — that route is admin-only); the
// BYOK/platform split is recomputed here for one user only.
export type MyAiUsage = {
  billingMode: AiBillingMode
  allowance: LimitCheck
  // Today's calls (UTC day), split BYOK vs platform.
  today: AiUsageSummary
  // All-time provider-reported cost, in micro-units.
  totalCostMicros: number
}

export async function getMyAiUsage(userId: string): Promise<MyAiUsage> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  })
  if (!user) throw new ApiError("User not found", 404)
  const dayStart = new Date()
  dayStart.setUTCHours(0, 0, 0, 0)
  const [billingMode, allowance, grouped, cost] = await Promise.all([
    getUserAiBillingMode(userId),
    checkLimit(userId, "AI_REQUESTS"),
    db.aiUsageRecord.groupBy({
      by: ["billingMode", "status"],
      where: { userId, createdAt: { gte: dayStart } },
      _count: { _all: true },
      _sum: { tokensIn: true, tokensOut: true, costMicros: true },
    }),
    db.aiUsageRecord.aggregate({
      _sum: { costMicros: true },
      where: { userId },
    }),
  ])
  return {
    billingMode,
    allowance,
    today: toAiUsageSummary(grouped),
    totalCostMicros: cost._sum.costMicros ?? 0,
  }
}

// ─── Admin: a user's keys ──────────────────────────────────────────────

/** Metadata only — never key material. */
export async function listUserAiKeysForAdmin(
  actor: AdminSession,
  userId: string
): Promise<UserAiKeyMeta[]> {
  // SRC-236: one capability, not two — the route already gates on
  // MANAGE_AI, and every sibling admin AI function takes MANAGE_AI
  // alone. Requiring VIEW_CUSTOMER_DATA as well locked out the very
  // staff the AI section is for.
  requireAdmin(actor, "MANAGE_AI")
  await getUserOrThrow(userId)
  return listUserAiKeys(userId)
}
