import { createHash, randomUUID } from "node:crypto"
import {
  Prisma,
  SubmissionEventType,
  SubmissionStatus,
  db,
} from "@sendcms/database"
import type { FormField } from "@sendcms/database"

import {
  ApiError,
  getSubmissionSender,
  previewSubmissionText,
} from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"
import {
  generateDigest,
  getDigestIntervalHours,
  getSpamThreshold,
  isAiConfigured,
  rescoreSpam,
  type AiCallUsage,
} from "@sendcms/ai"
import {
  anyByokKeyConfigured,
  recordAiUsage,
  resolveAiModelForUserSafe,
  type ResolvedAiModel,
} from "@sendcms/ai-settings"
import { normalizeDomain } from "@sendcms/domains"
import {
  checkLimitSafe,
  getEffectiveEntitlementsSafe,
  recordUsage,
  startOfUtcMonth,
} from "@sendcms/plans"
import { isFeatureEnabled } from "@sendcms/platform-ops"
import {
  enqueueDigest,
  enqueueSubmissionNotifications,
} from "@sendcms/notifications"
import { verifyTurnstileToken } from "./turnstile"
import { HONEYPOT_FIELD, type SubmitBodyInput } from "./validators"

const logger = createLogger("submissions")

// Public submission API (Phase 5). No session, no cookies — the only
// authorization is the Origin allowlist: the submitting site must be a
// VERIFIED domain linked to the form. That is also the CSRF protection
// for this endpoint (classic cookie CSRF does not apply — nothing here
// reads a session cookie).

export const MAX_VALUE_LENGTH = 10_000
export const MAX_PAYLOAD_BYTES = 64_000
export const DEDUPE_WINDOW_MINUTES = 10
export const IP_MINUTE_LIMIT = 10
export const IP_HOUR_LIMIT = 100

type FormWithConfig = Prisma.FormGetPayload<{
  include: {
    fields: true
    domainLinks: { include: { domain: true } }
  }
}>

export type SubmitMeta = {
  origin: string | null
  ip: string | null
  userAgent: string | null
}

export type SubmitResult =
  | {
      kind: "created" | "duplicate"
      submission: { id: string }
      originAllowed: true
      message: string
      redirectUrl: string | null
    }
  | {
      kind: "honeypot"
      fakeId: string
      originAllowed: true
      message: string
      redirectUrl: string | null
    }

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export function sanitizeString(value: string): string {
  // Trim, drop control characters except newline/tab, cap length.
  // HTML is NOT stripped here — the inbox renders with React, which
  // escapes by default; stripping tags would mangle legitimate text.
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim()
}

export function getOriginHost(origin: string | null): string | null {
  if (!origin) return null
  try {
    return normalizeDomain(new URL(origin).hostname)
  } catch {
    return null
  }
}

export function isOriginAllowedForForm(
  form: FormWithConfig,
  origin: string | null
): boolean {
  const host = getOriginHost(origin)
  if (!host) return false
  return form.domainLinks.some(
    (link) =>
      link.domain.status === "VERIFIED" &&
      normalizeDomain(link.domain.domain) === host
  )
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const URL_RE = /^https?:\/\/\S+$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type SanitizedValue = string | number | string[]

export function validateSubmissionFields(
  fields: Record<string, unknown>,
  configs: FormField[]
): Record<string, SanitizedValue> {
  const byName = new Map(configs.map((c) => [c.name, c]))
  for (const key of Object.keys(fields)) {
    if (!byName.has(key)) {
      throw new ApiError(`Unknown field: "${key}"`, 422)
    }
  }

  const out: Record<string, SanitizedValue> = {}
  for (const config of configs) {
    const raw = fields[config.name]
    const present =
      raw !== undefined &&
      raw !== null &&
      !(typeof raw === "string" && raw.trim() === "") &&
      !(Array.isArray(raw) && raw.length === 0)

    if (!present) {
      if (config.required) {
        throw new ApiError(`"${config.label}" is required`, 422)
      }
      continue
    }

    const options = Array.isArray(config.options)
      ? (config.options as string[])
      : null

    switch (config.type) {
      case "TEXT":
      case "TEXTAREA":
      case "TEL":
      case "DATE":
      case "URL":
      case "EMAIL": {
        if (typeof raw !== "string") {
          throw new ApiError(`"${config.label}" must be text`, 422)
        }
        const value = sanitizeString(raw)
        if (value.length > MAX_VALUE_LENGTH) {
          throw new ApiError(`"${config.label}" is too long`, 422)
        }
        if (config.minLength != null && value.length < config.minLength) {
          throw new ApiError(
            `"${config.label}" must be at least ${config.minLength} characters`,
            422
          )
        }
        if (config.maxLength != null && value.length > config.maxLength) {
          throw new ApiError(
            `"${config.label}" must be at most ${config.maxLength} characters`,
            422
          )
        }
        if (config.type === "EMAIL" && !EMAIL_RE.test(value)) {
          throw new ApiError(`"${config.label}" must be a valid email`, 422)
        }
        if (config.type === "URL" && !URL_RE.test(value)) {
          throw new ApiError(`"${config.label}" must be a valid URL`, 422)
        }
        if (config.type === "DATE" && !DATE_RE.test(value)) {
          throw new ApiError(
            `"${config.label}" must be a date (YYYY-MM-DD)`,
            422
          )
        }
        out[config.name] = value
        break
      }
      case "NUMBER": {
        const num =
          typeof raw === "number"
            ? raw
            : Number(typeof raw === "string" ? raw.trim() : NaN)
        if (!Number.isFinite(num)) {
          throw new ApiError(`"${config.label}" must be a number`, 422)
        }
        out[config.name] = num
        break
      }
      case "SELECT":
      case "RADIO": {
        if (typeof raw !== "string") {
          throw new ApiError(`"${config.label}" must be text`, 422)
        }
        const value = sanitizeString(raw)
        if (options && !options.includes(value)) {
          throw new ApiError(
            `"${config.label}" must be one of: ${options.join(", ")}`,
            422
          )
        }
        out[config.name] = value
        break
      }
      case "CHECKBOX": {
        const values = Array.isArray(raw) ? raw : [raw]
        const cleaned: string[] = []
        for (const v of values) {
          if (typeof v !== "string") {
            throw new ApiError(`"${config.label}" must be text`, 422)
          }
          const value = sanitizeString(v)
          if (options && !options.includes(value)) {
            throw new ApiError(
              `"${config.label}" must be one of: ${options.join(", ")}`,
              422
            )
          }
          cleaned.push(value)
        }
        out[config.name] = cleaned
        break
      }
    }
  }
  return out
}

export function computeContentHash(
  formId: string,
  data: Record<string, SanitizedValue>
): string {
  const canonical = JSON.stringify(
    Object.keys(data)
      .sort()
      .map((k) => [k, data[k]])
  )
  return createHash("sha256").update(`${formId}:${canonical}`).digest("hex")
}

const LINK_RE = /(https?:\/\/|www\.)\S+/gi

export function detectSpam(data: Record<string, SanitizedValue>): string[] {
  const reasons: string[] = []
  let links = 0
  for (const value of Object.values(data)) {
    const texts = Array.isArray(value) ? value : [value]
    for (const text of texts) {
      if (typeof text !== "string") continue
      links += text.match(LINK_RE)?.length ?? 0
      // Keyword stuffing: one word (4+ chars) repeated 10+ times.
      const words = text
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length >= 4)
      const counts = new Map<string, number>()
      for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1)
      for (const [, count] of counts) {
        if (count >= 10) {
          reasons.push("repeated content")
          break
        }
      }
    }
  }
  if (links > 3) reasons.push("too many links")
  return [...new Set(reasons)]
}

// ---------------------------------------------------------------------------
// Submission flow
// ---------------------------------------------------------------------------

export async function submitForm(
  body: SubmitBodyInput,
  meta: SubmitMeta
): Promise<SubmitResult> {
  const form = await db.form.findFirst({
    where: { id: body.formId, ownerId: body.userId },
    include: {
      fields: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] },
      domainLinks: { include: { domain: true } },
    },
  })
  if (!form) throw new ApiError("Form not found", 404)

  const originAllowed = isOriginAllowedForForm(form, meta.origin)
  // Returns (rather than throws) the error so call sites use a plain
  // `throw` — TS narrows after `throw` but not after a call to a
  // never-returning closure (verified with TS 6.0.3).
  const fail = (message: string, status: number): ApiError => {
    const err = new ApiError(message, status)
    err.originAllowed = originAllowed
    return err
  }

  if (!form.active) {
    throw fail("This form is not accepting submissions right now.", 403)
  }
  if (!originAllowed) {
    throw fail("This form does not accept submissions from this site.", 403)
  }

  const message = form.successMessage ?? "Thanks! We'll get back to you soon."
  const redirectUrl = form.redirectUrl ?? null

  // Honeypot: fake a normal success, save nothing. Bots cannot tell.
  if (
    form.honeypotEnabled &&
    typeof body[HONEYPOT_FIELD] === "string" &&
    body[HONEYPOT_FIELD].trim() !== ""
  ) {
    return {
      kind: "honeypot",
      fakeId: randomUUID(),
      originAllowed: true,
      message,
      redirectUrl,
    }
  }

  // Turnstile (only when the form has it on).
  if (form.turnstileEnabled) {
    if (!process.env.TURNSTILE_SECRET_KEY) {
      throw fail("Bot protection is not configured for this form.", 503)
    }
    const token = body.turnstileToken
    if (!token) {
      throw fail("Verification is required for this form.", 422)
    }
    const ok = await verifyTurnstileToken(token, meta.ip)
    if (!ok) {
      throw fail("Verification failed. Please try again.", 403)
    }
  }

  const data = validateSubmissionFields(body.fields, form.fields)
  if (JSON.stringify(data).length > MAX_PAYLOAD_BYTES) {
    throw fail("Submission is too large.", 413)
  }

  // Idempotency: the same key returns the original submission.
  if (body.idempotencyKey) {
    const existing = await db.submission.findUnique({
      where: {
        formId_idempotencyKey: {
          formId: form.id,
          idempotencyKey: body.idempotencyKey,
        },
      },
    })
    if (existing) {
      return {
        kind: "duplicate",
        submission: { id: existing.id },
        originAllowed: true,
        message,
        redirectUrl,
      }
    }
  }

  const contentHash = computeContentHash(form.id, data)
  const dedupeSince = new Date(Date.now() - DEDUPE_WINDOW_MINUTES * 60_000)
  const recentSame = await db.submission.findFirst({
    where: {
      formId: form.id,
      contentHash,
      createdAt: { gte: dedupeSince },
    },
    orderBy: { createdAt: "desc" },
  })
  if (recentSame) {
    return {
      kind: "duplicate",
      submission: { id: recentSame.id },
      originAllowed: true,
      message,
      redirectUrl,
    }
  }

  // DB-backed rate limits (no in-memory state — safe across isolates).
  if (form.dailyLimit != null) {
    const dayStart = new Date()
    dayStart.setUTCHours(0, 0, 0, 0)
    const today = await db.submission.count({
      where: { formId: form.id, createdAt: { gte: dayStart } },
    })
    if (today >= form.dailyLimit) {
      throw fail("This form has reached its daily submission limit.", 429)
    }
  }
  // Plan quota (Phase 4): the form owner's monthly submission quota
  // from their effective plan. Fail-open — any error in the check must
  // NOT fail the submission (the core path stays independent of the
  // plans module). Reject ONLY when the submission quota itself is
  // exhausted — never because an unrelated AI/billing limit was hit.
  const quota = await checkLimitSafe(form.ownerId, "SUBMISSIONS")
  if (quota && !quota.allowed) {
    throw fail("This form's monthly submission quota is exhausted.", 402)
  }
  if (meta.ip) {
    const minuteAgo = new Date(Date.now() - 60_000)
    const recent = await db.submission.count({
      where: { ipAddress: meta.ip, createdAt: { gte: minuteAgo } },
    })
    if (recent >= IP_MINUTE_LIMIT) {
      throw fail(
        "Too many submissions. Please wait a minute and try again.",
        429
      )
    }
    const hourAgo = new Date(Date.now() - 3_600_000)
    const hourly = await db.submission.count({
      where: { ipAddress: meta.ip, createdAt: { gte: hourAgo } },
    })
    if (hourly >= IP_HOUR_LIMIT) {
      throw fail(
        "Too many submissions from this address. Try again later.",
        429
      )
    }
  }

  const spamReasons = detectSpam(data)
  const status =
    spamReasons.length > 0 ? SubmissionStatus.SPAM : SubmissionStatus.NEW

  // Durable save BEFORE the success response: submission + CREATED event
  // in one transaction. A concurrent duplicate idempotency key surfaces
  // as P2002 — re-read and return the original instead of erroring.
  try {
    const created = await db.$transaction(async (tx) => {
      const submission = await tx.submission.create({
        data: {
          formId: form.id,
          data,
          status,
          originDomain: getOriginHost(meta.origin) ?? "unknown",
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
          pageUrl: body.pageUrl,
          idempotencyKey: body.idempotencyKey,
          contentHash,
        },
      })
      await tx.submissionEvent.create({
        data: {
          submissionId: submission.id,
          type: SubmissionEventType.CREATED,
          detail:
            spamReasons.length > 0
              ? { spamReasons }
              : { origin: getOriginHost(meta.origin) },
        },
      })
      return submission
    })
    // Notifications are queued AFTER the durable save — a dead mail
    // Notifications are queued AFTER the durable save — a dead mail
    // provider must never lose or block a submission. This is AWAITED
    // (not fire-and-forget): the submit route's `after()` hook runs
    // `processEmailOutbox` right after the response, and it can only
    // send jobs that already exist. An enqueue failure is logged
    // loudly (there is no job for the cron to retry in that case);
    // the submission itself is already safe.
    if (status === SubmissionStatus.NEW) {
      try {
        await enqueueSubmissionNotifications(form.id, created.id)
      } catch (err) {
        logger.error("failed to queue jobs for submission", {
          submissionId: created.id,
          error: err,
        })
      }
    }
    // Usage ledger (Phase 4, reporting): one row per accepted
    // submission, idempotencyKey = the submission id so a retry can
    // never double-count. Best-effort — a ledger failure must never
    // fail the submission.
    try {
      await recordUsage({
        userId: form.ownerId,
        meter: "SUBMISSIONS",
        quantity: 1,
        unit: "submission",
        period: startOfUtcMonth().toISOString(),
        sourceEvent: "submission:created",
        idempotencyKey: created.id,
        resourceId: created.id,
      })
    } catch (err) {
      logger.error("failed to record submission usage", {
        submissionId: created.id,
        error: err,
      })
    }
    return {
      kind: "created",
      submission: { id: created.id },
      originAllowed: true,
      message,
      redirectUrl,
    }
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002" &&
      body.idempotencyKey
    ) {
      const existing = await db.submission.findUnique({
        where: {
          formId_idempotencyKey: {
            formId: form.id,
            idempotencyKey: body.idempotencyKey,
          },
        },
      })
      if (existing) {
        return {
          kind: "duplicate",
          submission: { id: existing.id },
          originAllowed: true,
          message,
          redirectUrl,
        }
      }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// AI spam re-scoring (Phase 12, Step 2)
// ---------------------------------------------------------------------------
// Async, after the save: the worker (and the cron route on serverless)
// re-scores NEW submissions on AI-enabled forms. The model can only
// ADD spam flags — a submission the heuristics (or a human) already
// marked SPAM is never touched, and a low score never unflags one.
// When no provider is configured the whole step is a no-op, so the
// submit path and the inbox behave exactly as before.

/** Model calls allowed per form per day. Overridable via AI_DAILY_CALL_CAP. */
export const DEFAULT_AI_DAILY_CALL_CAP = 100

export function getAiDailyCallCap(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.AI_DAILY_CALL_CAP)
  if (Number.isFinite(raw) && raw > 0) return Math.trunc(raw)
  return DEFAULT_AI_DAILY_CALL_CAP
}

/** UTC midnight starting the day `at` falls on — the AiDailyUsage bucket. */
export function startOfUtcDay(at: Date = new Date()): Date {
  const day = new Date(at)
  day.setUTCHours(0, 0, 0, 0)
  return day
}

export type RescoreResult = {
  checked: number
  markedSpam: number
  skipped: number
}

/** Feature-flag keys for the AI background jobs (Admin Control Plane,
    Phase 8). An admin creates and enables these in /admin/features;
    a missing or disabled flag turns its job off — fail-closed. */
export const AI_SPAM_RESCORE_FLAG = "ai-spam-rescore"
export const AI_DIGEST_FLAG = "ai-digest"

/** Re-scores unscored NEW submissions on AI-enabled forms. Returns the
    outcome counts. A single failed model call is logged and skipped —
    it never fails the batch. */
export async function rescoreNewSubmissions({
  limit = 25,
  env = process.env,
}: {
  limit?: number
  env?: NodeJS.ProcessEnv
} = {}): Promise<RescoreResult> {
  // Feature flag first: a missing or disabled flag turns the job off
  // (fail-closed) — the admin enables it in /admin/features.
  if (!(await isFeatureEnabled(AI_SPAM_RESCORE_FLAG))) {
    return { checked: 0, markedSpam: 0, skipped: 0 }
  }
  // The gate is "any AI at all": the platform key OR any stored BYOK
  // key. A BYOK-only deployment (no platform key) still runs its AI
  // jobs; per-owner resolution below decides which key each call uses.
  if (!isAiConfigured(env) && !(await anyByokKeyConfigured())) {
    return { checked: 0, markedSpam: 0, skipped: 0 }
  }
  const threshold = getSpamThreshold(env)
  const today = startOfUtcDay()

  const candidates = await db.submission.findMany({
    where: {
      status: SubmissionStatus.NEW,
      aiScoredAt: null,
      form: { aiEnabled: true },
    },
    include: { form: { select: { id: true, name: true, ownerId: true } } },
    orderBy: { createdAt: "asc" },
    take: limit,
  })

  // The daily cap is the form OWNER's aiRequestsPerDay from their
  // effective plan (Phase 4) — previously it was the global env default
  // for every form. The usage counter stays per form (AiDailyUsage is
  // keyed by form + day); the cap VALUE is what is now per-owner.
  // A suspended owner has null entitlements → cap 0 (skipped). A failed
  // lookup (null) → the env default, so a plans-module error never
  // stops the rescore loop.
  const ownerCap = new Map<string, number>()
  async function getOwnerCap(ownerId: string | undefined): Promise<number> {
    if (!ownerId) return getAiDailyCallCap(env)
    const cached = ownerCap.get(ownerId)
    if (cached !== undefined) return cached
    const effective = await getEffectiveEntitlementsSafe(ownerId)
    const cap =
      effective === null
        ? getAiDailyCallCap(env)
        : effective.entitlements
          ? (effective.entitlements.aiRequestsPerDay ?? getAiDailyCallCap(env))
          : 0
    ownerCap.set(ownerId, cap)
    return cap
  }

  // Resolved once per form owner per run: the same owner keeps the
  // same mode/key for the whole batch. A null means "no AI for this
  // owner" (BYOK without a key, disabled, suspended) — those
  // submissions are skipped, never dropped.
  const ownerModel = new Map<string, ResolvedAiModel | null>()
  async function getOwnerModel(
    ownerId: string
  ): Promise<ResolvedAiModel | null> {
    if (ownerModel.has(ownerId)) return ownerModel.get(ownerId) ?? null
    const resolved = await resolveAiModelForUserSafe(ownerId, {
      purpose: "spam-rescore",
      env,
    })
    ownerModel.set(ownerId, resolved)
    return resolved
  }

  let checked = 0
  let markedSpam = 0
  let skipped = 0
  const cappedForms = new Set<string>()
  for (const submission of candidates) {
    const formId = submission.formId
    if (cappedForms.has(formId)) {
      skipped++
      continue
    }
    const cap = await getOwnerCap(submission.form.ownerId)
    const usage = await db.aiDailyUsage.findUnique({
      where: { formId_date: { formId, date: today } },
    })
    if ((usage?.calls ?? 0) >= cap) {
      cappedForms.add(formId)
      skipped++
      continue
    }
    const resolved = await getOwnerModel(submission.form.ownerId)
    if (!resolved) {
      skipped++
      continue
    }
    let verdict
    const callUsage: { current: AiCallUsage | null } = { current: null }
    try {
      verdict = await rescoreSpam({
        model: resolved.model,
        formName: submission.form.name,
        data: submission.data as Record<string, unknown>,
        onUsage: (u) => {
          callUsage.current = u
        },
      })
    } catch (err) {
      // A failed model call is retried on a later poll (the row stays
      // unscored) — it must not fail the batch or lose the submission.
      logger.error("ai rescore failed", { error: err, formId })
      await recordAiUsage({
        userId: submission.form.ownerId,
        provider: resolved.provider,
        model: resolved.modelId,
        billingMode: resolved.billingMode,
        status: "FAILED",
        sourceEvent: "spam-rescore",
        resourceId: submission.id,
      })
      skipped++
      continue
    }
    await db.aiDailyUsage.upsert({
      where: { formId_date: { formId, date: today } },
      create: { formId, date: today, calls: 1 },
      update: { calls: { increment: 1 } },
    })
    await recordAiUsage({
      userId: submission.form.ownerId,
      provider: resolved.provider,
      model: resolved.modelId,
      billingMode: resolved.billingMode,
      status: "SUCCESS",
      tokensIn: callUsage.current?.promptTokens ?? null,
      tokensOut: callUsage.current?.completionTokens ?? null,
      sourceEvent: "spam-rescore",
      resourceId: submission.id,
    })
    const isSpam = verdict.score >= threshold
    const now = new Date()
    await db.$transaction(async (tx) => {
      await tx.submission.update({
        where: { id: submission.id },
        data: {
          aiSpamScore: verdict.score,
          aiScoredAt: now,
          ...(isSpam ? { status: SubmissionStatus.SPAM } : {}),
        },
      })
      if (isSpam) {
        await tx.submissionEvent.create({
          data: {
            submissionId: submission.id,
            type: SubmissionEventType.MARKED_SPAM,
            detail: {
              source: "ai",
              score: verdict.score,
              reason: verdict.reason,
            },
          },
        })
      }
    })
    checked++
    if (isSpam) markedSpam++
  }
  return { checked, markedSpam, skipped }
}

// ---------------------------------------------------------------------------
// AI inbox digest (Phase 12, Step 3)
// ---------------------------------------------------------------------------
// Once per interval (AI_DIGEST_INTERVAL_HOURS, default 24 = daily),
// the worker emails each AI-enabled form's owner a summary of the
// form's NEW submissions since the last digest. The model writes the
// summary; the email goes through the outbox (EmailJobType.DIGEST)
// so delivery is retried like any other notification. A form with no
// new submissions gets no email, and the window only advances when a
// digest is actually sent.

/** New submissions in a digest, most recent last. */
export const DIGEST_MAX_SUBMISSIONS = 50

export type DigestResult = {
  sent: number
  skipped: number
}

function dashboardInboxUrl(formId: string): string {
  const base =
    process.env.NEXT_PUBLIC_DASHBOARD_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3002"
  return `${base}/dashboard/inbox?formId=${formId}`
}

/** Sends every due digest. Returns the outcome counts. A single
    failed model call is logged and the form is skipped — it never
    fails the batch, and the window does not advance. */
export async function sendDueDigests({
  limit = 25,
  env = process.env,
}: {
  limit?: number
  env?: NodeJS.ProcessEnv
} = {}): Promise<DigestResult> {
  // Feature flag first: a missing or disabled flag turns the job off
  // (fail-closed) — the admin enables it in /admin/features.
  if (!(await isFeatureEnabled(AI_DIGEST_FLAG))) {
    return { sent: 0, skipped: 0 }
  }
  if (!isAiConfigured(env) && !(await anyByokKeyConfigured())) {
    return { sent: 0, skipped: 0 }
  }
  const intervalMs = getDigestIntervalHours(env) * 3_600_000
  const dueAt = new Date(Date.now() - intervalMs)

  const forms = await db.form.findMany({
    where: {
      aiEnabled: true,
      OR: [{ lastDigestAt: null }, { lastDigestAt: { lte: dueAt } }],
    },
    include: { owner: { select: { email: true } } },
    orderBy: { createdAt: "asc" },
    take: limit,
  })

  // Resolved once per form owner per run (see rescore above).
  const ownerModel = new Map<string, ResolvedAiModel | null>()
  async function getOwnerModel(
    ownerId: string
  ): Promise<ResolvedAiModel | null> {
    if (ownerModel.has(ownerId)) return ownerModel.get(ownerId) ?? null
    const resolved = await resolveAiModelForUserSafe(ownerId, {
      purpose: "digest",
      env,
    })
    ownerModel.set(ownerId, resolved)
    return resolved
  }

  let sent = 0
  let skipped = 0
  for (const form of forms) {
    const since = form.lastDigestAt ?? new Date(0)
    const submissions = await db.submission.findMany({
      where: {
        formId: form.id,
        status: SubmissionStatus.NEW,
        createdAt: { gt: since },
      },
      orderBy: { createdAt: "asc" },
      take: DIGEST_MAX_SUBMISSIONS,
    })
    if (submissions.length === 0) {
      skipped++
      continue
    }
    const resolved = await getOwnerModel(form.ownerId)
    if (!resolved) {
      skipped++
      continue
    }
    let summary
    const callUsage: { current: AiCallUsage | null } = { current: null }
    try {
      summary = await generateDigest({
        model: resolved.model,
        formName: form.name,
        submissions: submissions.map((s) => {
          const sender = getSubmissionSender(s.data)
          return {
            senderName: sender.name,
            senderEmail: sender.email,
            snippet: previewSubmissionText(s.data).slice(0, 200),
            receivedAt: s.createdAt,
          }
        }),
        onUsage: (u) => {
          callUsage.current = u
        },
      })
    } catch (err) {
      // A failed model call retries on a later poll (the window does
      // not advance) — it must not fail the batch.
      logger.error("ai digest failed", { error: err, formId: form.id })
      await recordAiUsage({
        userId: form.ownerId,
        provider: resolved.provider,
        model: resolved.modelId,
        billingMode: resolved.billingMode,
        status: "FAILED",
        sourceEvent: "digest",
        resourceId: form.id,
      })
      skipped++
      continue
    }
    await recordAiUsage({
      userId: form.ownerId,
      provider: resolved.provider,
      model: resolved.modelId,
      billingMode: resolved.billingMode,
      status: "SUCCESS",
      tokensIn: callUsage.current?.promptTokens ?? null,
      tokensOut: callUsage.current?.completionTokens ?? null,
      sourceEvent: "digest",
      resourceId: form.id,
    })
    const now = new Date()
    // Enqueue first, then advance the window: a failed enqueue must
    // not move the window (those submissions would be lost), while a
    // failed window update only re-sends the same digest on the next
    // poll. (Same rule as the submission notifications: enqueue after
    // the save, never inside its transaction.)
    await enqueueDigest({
      formId: form.id,
      to: form.owner.email,
      subject: `${submissions.length} new submission${submissions.length === 1 ? "" : "s"} on ${form.name}`,
      payload: {
        formName: form.name,
        count: submissions.length,
        summary: summary.summary,
        highlights: summary.highlights,
        items: submissions.map((s) => {
          const sender = getSubmissionSender(s.data)
          return {
            senderName: sender.name,
            snippet: previewSubmissionText(s.data).slice(0, 200),
            receivedAt: s.createdAt,
          }
        }),
        inboxUrl: dashboardInboxUrl(form.id),
        accentColor: "#0891b2",
        footerText:
          "You're receiving this because you get digests for this form.",
      },
    })
    await db.form.update({
      where: { id: form.id },
      data: { lastDigestAt: now },
    })
    sent++
  }
  return { sent, skipped }
}
