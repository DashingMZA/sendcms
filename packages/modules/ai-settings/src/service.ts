import { generateText } from "ai"
import type { AdminSession } from "@sendcms/auth"
import {
  DEFAULT_MODELS,
  PROVIDER_ENV_VARS,
  decryptByokKey,
  encryptByokKey,
  getAiModelForKey,
  getAiModelId,
  getAiModel,
  isAiConfigured,
  normalizeAiEnv,
  resolveAiProvider,
  toAiCallUsage,
  type AiCallUsage,
  type AiEnvConfig,
  type AiProviderName,
} from "@sendcms/ai"
import { AuditAction, AuditResource, db } from "@sendcms/database"
import type {
  AiBillingMode,
  AiKeyTestStatus,
  AiProvider,
  AiUsageStatus,
  Prisma,
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
    lastTestedAt: row.lastTestedAt,
    lastTestStatus: row.lastTestStatus,
    // Last 4 hex chars of the SHA-256 fingerprint — display only, it
    // can never be reversed into the key.
    fingerprintLast4: row.keyFingerprint.slice(-4),
  }
}

async function getUserOrThrow(userId: string): Promise<{
  id: string
  status: "ACTIVE" | "SUSPENDED" | "DISABLED"
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
    the provider + fingerprint last4 — never key material. */
export async function saveUserAiKey(
  userId: string,
  input: SaveAiKeyInput
): Promise<UserAiKeyMeta> {
  const user = await getUserOrThrow(userId)
  assertNotSuspended(user)
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

// ─── Test button ──────────────────────────────────────────────────────

export type AiKeyTestResult = {
  ok: boolean
  latencyMs: number
  model: string
  error?: string
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
async function probeKey(
  provider: AiProviderName,
  apiKey: string,
  modelId: string
): Promise<{
  ok: boolean
  latencyMs: number
  model: string
  error?: string
  usage: AiCallUsage | null
}> {
  const started = Date.now()
  try {
    const model = getAiModelForKey(provider, apiKey, modelId)
    const result = await generateText({
      model,
      prompt: "Reply with the single word: ok",
      maxOutputTokens: 1,
    })
    return {
      ok: true,
      latencyMs: Date.now() - started,
      model: modelId,
      usage: toAiCallUsage(result.usage),
    }
  } catch (err) {
    // Sanitised (AIM-006): a provider error can echo part of the key
    // — the raw message never leaves this function.
    return {
      ok: false,
      latencyMs: Date.now() - started,
      model: modelId,
      error: sanitizeKeyTestError(
        err instanceof Error ? err.message : "Key test failed.",
        apiKey
      ),
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
  provider: AiProviderName
): Promise<AiKeyTestResult> {
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
  // lowercase provider name (see the mapping above).
  let apiKey: string
  try {
    apiKey = decryptByokKey({
      userId: row.userId,
      provider,
      encryptedKey: row.encryptedKey,
      encryptedDek: row.encryptedDek,
      keyIv: row.keyIv,
      keyTag: row.keyTag,
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
    await recordAiUsage({
      userId,
      provider,
      model: modelId,
      billingMode: "BYOK",
      status: "FAILED",
      sourceEvent: "key-test",
      resourceId: row.id,
    })
    return { ok: false, latencyMs: 0, model: modelId, error }
  }
  const probe = await probeKey(provider, apiKey, modelId)
  if (!probe.ok) {
    // The log carries the sanitised probe error plus the fingerprint
    // last4 (AIM-006) — never key material.
    logger.warn("byok key test failed", {
      userId,
      provider,
      error: probe.error,
      fingerprintLast4: row.keyFingerprint.slice(-4),
    })
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
  await recordAiUsage({
    userId,
    provider,
    model: modelId,
    billingMode: "BYOK",
    status: probe.ok ? "SUCCESS" : "FAILED",
    tokensIn: probe.usage?.promptTokens ?? null,
    tokensOut: probe.usage?.completionTokens ?? null,
    sourceEvent: "key-test",
    resourceId: row.id,
  })
  return {
    ok: probe.ok,
    latencyMs: probe.latencyMs,
    model: modelId,
    ...(probe.error ? { error: probe.error } : {}),
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
  model?: string
): Promise<AiKeyTestResult> {
  await assertAiTestAllowed(userId)
  if (typeof apiKey !== "string" || apiKey.trim().length < 8) {
    throw new ApiError("A valid API key is required to test it.", 422)
  }
  const modelId = model?.trim() || DEFAULT_MODELS[provider]
  const probe = await probeKey(provider, apiKey.trim(), modelId)
  if (!probe.ok) {
    // Sanitised by probeKey (AIM-006) — never key material.
    logger.warn("browser key test failed", {
      userId,
      provider,
      error: probe.error,
    })
  }
  await recordAiUsage({
    userId,
    provider,
    model: modelId,
    billingMode: "BYOK",
    status: probe.ok ? "SUCCESS" : "FAILED",
    tokensIn: probe.usage?.promptTokens ?? null,
    tokensOut: probe.usage?.completionTokens ?? null,
    sourceEvent: "key-test",
  })
  return {
    ok: probe.ok,
    latencyMs: probe.latencyMs,
    model: modelId,
    ...(probe.error ? { error: probe.error } : {}),
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
    made the call. costMicros is only set when the caller passes a
    reliable provider-reported cost; never an estimate. */
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

// Env vars for provider detection in the legacy fallback path.
// Mirrors PROVIDER_ENV_VARS in @sendcms/ai; kept local so the
// fallback works even when @sendcms/ai is only partially available
// (e.g. under the existing service tests, which mock the ai package).
const LEGACY_PROVIDER_ENV_VARS: Record<AiProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
}

function detectProviderFromEnv(env: NodeJS.ProcessEnv): AiProviderName | null {
  const explicit = env.AI_PROVIDER?.trim().toLowerCase()
  if (explicit && (AI_PROVIDER_NAMES as readonly string[]).includes(explicit)) {
    return explicit as AiProviderName
  }
  for (const provider of AI_PROVIDER_NAMES) {
    if (env[LEGACY_PROVIDER_ENV_VARS[provider]]) return provider
  }
  return null
}

/** The pre-BYOK platform path: the system's .env key, resolved the
    way the capabilities did before Phase 5. Used ONLY when the
    settings store itself is unreadable (the mode cannot be known) —
    see the resolver. It is a store-availability fallback, NOT a key
    fallback: it never runs when the mode is known to be BYOK. */
async function resolveAiModelLegacy(
  env: NodeJS.ProcessEnv,
  providerHint?: AiProviderName
): Promise<ResolvedAiModel> {
  if (!isAiConfigured(env)) {
    throw new AiNotAvailableError(
      "No AI provider is configured. Set a provider key first."
    )
  }
  const model = getAiModel(env)
  const provider = providerHint ?? detectProviderFromEnv(env) ?? "openai"
  const modelId =
    typeof (model as { modelId?: unknown }).modelId === "string"
      ? (model as { modelId: string }).modelId
      : DEFAULT_MODELS[provider]
  return { model, billingMode: "PLATFORM", provider, modelId }
}

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
    bound to one provider and must never be sent to another. Shared
    by the resolution below and by the store-unreadable fallback,
    where the mode could not be determined at all. */
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
    PLATFORM — the platform key via getAiModel(), only when the plan
    allows platform AI, the admin has the provider enabled, and the
    Phase 4 emergency flag is off (the emergency flag is folded into
    the effective entitlements by @sendcms/plans); (4) DISABLED or
    nothing configured — a clear "AI is not available" error, so
    callers degrade to the non-AI behavior.
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
  // settings store itself is unreadable, fall back to the platform
  // default — the mode could not be determined, so there is no
  // DISABLED mode to protect (a browser-only key still resolves
  // for this one call, below). This is a STORE-AVAILABILITY
  // fallback, not a key fallback: once the mode is known to be
  // BYOK, a missing/disabled/failing key NEVER falls back to the
  // platform key (below). Clean ApiErrors (unknown user)
  // propagate; only unexpected store errors fall through to the
  // platform default.
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
    logger.warn("ai settings unreadable, using platform default", {
      error: err,
      userId,
      purpose: opts.purpose,
    })
    // The mode could not be determined, so no DISABLED mode is
    // being protected here: a browser-only key still resolves for
    // this one call, exactly as before the gate moved first.
    const fallbackBrowserKey = opts.browserKey?.trim()
    if (fallbackBrowserKey) {
      return resolveBrowserKeyModel(fallbackBrowserKey, opts)
    }
    return resolveAiModelLegacy(env, opts.provider)
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
  const provider = opts.provider ?? resolveAiProvider(env)
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
  return resolvePlatformModel(provider, env)
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

/** All five providers with their config. Missing rows are auto-created
    with defaults on first read, so the admin always sees all five. */
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
  const missing = AI_PROVIDER_NAMES.filter((p) => !byProvider.has(p))
  if (missing.length > 0) {
    await db.aiProviderConfig.createMany({
      data: missing.map((p) => ({
        provider: PROVIDER_NAME_TO_ENUM[p],
        ...PROVIDER_DEFAULTS[p],
      })),
      skipDuplicates: true,
    })
    const fresh = await db.aiProviderConfig.findMany({
      orderBy: { provider: "asc" },
    })
    return fresh.map(toProviderConfigRow)
  }
  return rows.map(toProviderConfigRow)
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
    detail: { event: "ai-provider-config-changed", provider },
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
  tokensIn: number
  tokensOut: number
  costMicros: number
}

export type AiUsageSummary = {
  byok: AiUsageModeSummary
  platform: AiUsageModeSummary
  total: AiUsageModeSummary
}

function emptyModeSummary(): AiUsageModeSummary {
  return {
    calls: 0,
    success: 0,
    failed: 0,
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

// One summarizer for the admin getAiUsageSummary and the customer
// getMyAiUsage below: BYOK vs PLATFORM totals, separated — never
// mixed. costMicros only counts provider-reported costs; it is never
// an estimate.
function toAiUsageSummary(grouped: AiUsageGroupRow[]): AiUsageSummary {
  const byMode = new Map<AiBillingMode, AiUsageModeSummary>()
  for (const g of grouped) {
    const bucket = byMode.get(g.billingMode) ?? emptyModeSummary()
    bucket.calls += g._count._all
    if (g.status === "SUCCESS") bucket.success += g._count._all
    if (g.status === "FAILED") bucket.failed += g._count._all
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
    tokensIn: byok.tokensIn + platform.tokensIn + disabled.tokensIn,
    tokensOut: byok.tokensOut + platform.tokensOut + disabled.tokensOut,
    costMicros: byok.costMicros + platform.costMicros + disabled.costMicros,
  }
  return { byok, platform, total }
}

/** BYOK vs PLATFORM totals, separated — never mixed. costMicros only
    counts provider-reported costs; it is never an estimate. */
export async function getAiUsageSummary(
  actor: AdminSession,
  filters: AiUsageSummaryQuery
): Promise<AiUsageSummary> {
  requireAdmin(actor, "VIEW_AI_USAGE")
  const where = usageWhere(filters)
  const grouped = await db.aiUsageRecord.groupBy({
    by: ["billingMode", "status"],
    where,
    _count: { _all: true },
    _sum: { tokensIn: true, tokensOut: true, costMicros: true },
  })
  return toAiUsageSummary(grouped)
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
