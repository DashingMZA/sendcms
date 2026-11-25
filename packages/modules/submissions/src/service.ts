import { createHash, randomUUID } from "node:crypto"
import {
  AuditAction,
  AuditResource,
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
  buildPlainDigestSummary,
  generateDigest,
  getDigestIntervalHours,
  getSpamThreshold,
  isAiConfigured,
  rescoreSpam,
  type AiCallUsage,
  type DigestSummary,
} from "@sendcms/ai"
import {
  anyByokKeyConfigured,
  recordAiUsage,
  resolveAiModelForUserSafe,
  type ResolvedAiModel,
} from "@sendcms/ai-settings"
import { normalizeDomain } from "@sendcms/domains"
import {
  checkLimitStrict,
  getEffectiveEntitlementsSafe,
  recordUsageInTransaction,
  startOfUtcMonth,
} from "@sendcms/plans"
import { isFeatureEnabled } from "@sendcms/platform-ops"
import { logAudit } from "@sendcms/security"
import {
  enqueueDigest,
  enqueueSubmissionNotifications,
} from "@sendcms/notifications"
import { isTurnstileConfigured, verifyTurnstileToken } from "./turnstile"
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

// SDK-019: seconds until the next UTC midnight — the daily-limit
// 429's `Retry-After` (the form's daily counter resets at midnight
// UTC). At least 1 so the header is never 0.
function secondsUntilMidnightUtc(): number {
  const now = new Date()
  const midnight = new Date(now)
  midnight.setUTCHours(24, 0, 0, 0)
  return Math.max(1, Math.ceil((midnight.getTime() - now.getTime()) / 1000))
}

// SRC-237: seconds until the next UTC month — the monthly-quota
// 429's `Retry-After` (the owner's monthly counter resets on the 1st,
// UTC). Quota exhaustion is a 429, not a 402: no client handles 402
// and the documented ApiError vocabulary has no 402 in it.
function secondsUntilNextUtcMonth(): number {
  const now = new Date()
  const nextMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  )
  return Math.max(1, Math.ceil((nextMonth.getTime() - now.getTime()) / 1000))
}

export async function submitForm(
  body: SubmitBodyInput,
  meta: SubmitMeta
): Promise<SubmitResult> {
  const form = await db.form.findFirst({
    where: { id: body.formId, ownerId: body.userId, deletedAt: null },
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
  // SDK-019: rate-limit throws carry the wait in seconds so the route
  // can emit a `Retry-After` header. ApiError has no retry field (it
  // lives in @sendcms/shared, outside this module), so the value rides
  // as an optional `retryAfterSeconds` property — the same pattern as
  // `originAllowed` above, which the route already reads. The header
  // itself is the route/api-client stream's part; the service's part
  // is emitting the value on every 429.
  const fail = (
    message: string,
    status: number,
    retryAfterSeconds?: number
  ): ApiError => {
    const err = new ApiError(message, status)
    err.originAllowed = originAllowed
    if (retryAfterSeconds !== undefined) {
      ;(err as ApiError & { retryAfterSeconds?: number }).retryAfterSeconds =
        retryAfterSeconds
    }
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

  // Turnstile (only when the form has it on). SDK-016: the token
  // check comes FIRST — with the secret check first, the 422
  // "Verification is required" branch was unreachable (every submit
  // 503d while the secret was unset, token or not). No token → 422
  // either way; a token with no server secret → 503 fail-closed,
  // worded for the owner (the misconfiguration is theirs to fix, not
  // the submitter's). The form service refuses to enable Turnstile in
  // an unconfigured environment, so the 503 should be rare.
  if (form.turnstileEnabled) {
    const token = body.turnstileToken
    if (!token) {
      throw fail("Verification is required for this form.", 422)
    }
    if (!isTurnstileConfigured()) {
      throw fail("Bot protection is not configured on this server.", 503)
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
      throw fail(
        "This form has reached its daily submission limit.",
        429,
        secondsUntilMidnightUtc()
      )
    }
  }
  // Plan quota (Phase 4): the form owner's monthly submission quota
  // from their effective plan. Fail-CLOSED (Phase 16, SRC-216) — a
  // plans-module error refuses the submission with 503 instead of
  // silently lifting the quota. Reject ONLY when the submission quota
  // itself is exhausted — never because an unrelated AI/billing limit
  // was hit.
  const quota = await checkLimitStrict(form.ownerId, "SUBMISSIONS")
  if (!quota.allowed) {
    throw fail(
      "This form's monthly submission quota is exhausted.",
      429,
      secondsUntilNextUtcMonth()
    )
  }
  if (meta.ip) {
    const minuteAgo = new Date(Date.now() - 60_000)
    const recent = await db.submission.count({
      where: { ipAddress: meta.ip, createdAt: { gte: minuteAgo } },
    })
    if (recent >= IP_MINUTE_LIMIT) {
      throw fail(
        "Too many submissions. Please wait a minute and try again.",
        429,
        60
      )
    }
    const hourAgo = new Date(Date.now() - 3_600_000)
    const hourly = await db.submission.count({
      where: { ipAddress: meta.ip, createdAt: { gte: hourAgo } },
    })
    if (hourly >= IP_HOUR_LIMIT) {
      throw fail(
        "Too many submissions from this address. Try again later.",
        429,
        3600
      )
    }
  }

  const spamReasons = detectSpam(data)
  const status =
    spamReasons.length > 0 ? SubmissionStatus.SPAM : SubmissionStatus.NEW

  // Durable save BEFORE the success response: submission + CREATED event
  // in one transaction. A concurrent duplicate idempotency key surfaces
  // as P2002 — re-read and return the original instead of erroring.
  //
  // Atomicity (Phase 16, SRC-204/DB-017): the checks above are fast
  // paths only — the ENFORCING checks run inside this transaction,
  // under transaction-scoped advisory locks, so two concurrent
  // identical submissions cannot both insert. Lock order is fixed
  // (owner → form → IP) so concurrent submits never deadlock each
  // other; the locks are released when the transaction ends. The
  // per-owner lock also serializes the monthly-quota re-check across
  // the owner's forms, and the per-IP lock serializes the IP limits
  // across forms.
  try {
    const outcome:
      | { kind: "duplicate"; duplicateOf: string }
      | { kind: "created"; submission: { id: string } } = await db.$transaction(
      async (tx) => {
        // pg_advisory_xact_lock returns void, which Prisma cannot
        // deserialize through $queryRaw ("Failed to deserialize column
        // of type 'void'") — $executeRaw takes the lock without
        // reading any result column.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"sendcms:submit:owner:" + form.ownerId}))`
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"sendcms:submit:form:" + form.id}))`
        if (meta.ip) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"sendcms:submit:ip:" + meta.ip}))`
        }
        // Dedupe, re-checked under the lock: a concurrent identical
        // submission that passed the fast path now sees this row.
        const lockedRecentSame = await tx.submission.findFirst({
          where: {
            formId: form.id,
            contentHash,
            createdAt: { gte: dedupeSince },
          },
          orderBy: { createdAt: "desc" },
        })
        if (lockedRecentSame) {
          return { kind: "duplicate", duplicateOf: lockedRecentSame.id }
        }
        if (form.dailyLimit != null) {
          const dayStart = new Date()
          dayStart.setUTCHours(0, 0, 0, 0)
          const today = await tx.submission.count({
            where: { formId: form.id, createdAt: { gte: dayStart } },
          })
          if (today >= form.dailyLimit) {
            throw fail(
              "This form has reached its daily submission limit.",
              429,
              secondsUntilMidnightUtc()
            )
          }
        }
        const lockedQuota = await checkLimitStrict(form.ownerId, "SUBMISSIONS")
        if (!lockedQuota.allowed) {
          throw fail(
            "This form's monthly submission quota is exhausted.",
            429,
            secondsUntilNextUtcMonth()
          )
        }
        if (meta.ip) {
          const minuteAgo = new Date(Date.now() - 60_000)
          const recent = await tx.submission.count({
            where: { ipAddress: meta.ip, createdAt: { gte: minuteAgo } },
          })
          if (recent >= IP_MINUTE_LIMIT) {
            throw fail(
              "Too many submissions. Please wait a minute and try again.",
              429,
              60
            )
          }
          const hourAgo = new Date(Date.now() - 3_600_000)
          const hourly = await tx.submission.count({
            where: { ipAddress: meta.ip, createdAt: { gte: hourAgo } },
          })
          if (hourly >= IP_HOUR_LIMIT) {
            throw fail(
              "Too many submissions from this address. Try again later.",
              429,
              3600
            )
          }
        }
        const submission = await tx.submission.create({
          data: {
            formId: form.id,
            // Phase 16 (PRF-011): denormalized owner, kept in sync on
            // create — the inbox / quota / analytics queries filter on
            // this column instead of joining Form. The value comes
            // from the already-loaded form, inside the same advisory
            // lock that serializes this owner's submits, so it cannot
            // disagree with the form's owner.
            ownerId: form.ownerId,
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
        // DB-050: the ledger row is written inside this transaction, so
        // a crash cannot lose the attribution row (idempotencyKey is the
        // submission id — a retry can never double-count).
        await recordUsageInTransaction(tx, {
          userId: form.ownerId,
          meter: "SUBMISSIONS",
          quantity: 1,
          unit: "submission",
          period: startOfUtcMonth().toISOString(),
          sourceEvent: "submission:created",
          idempotencyKey: submission.id,
          resourceId: submission.id,
        })
        return { kind: "created", submission }
      },
      // Prisma's interactive-transaction defaults (maxWait 2s, timeout
      // 5s) are too tight here on purpose: concurrent submits serialize
      // on the advisory locks above, so the Nth waiter legitimately
      // spends seconds queued behind the earlier transactions' indexed
      // queries — with the defaults it dies with P2028 instead of
      // getting its turn (proven live: a 12-way burst against the
      // remote dev DB hit "Unable to start a transaction in the given
      // time" at the 5s default). The transaction itself is a bounded
      // handful of indexed reads + two inserts, so the headroom covers
      // burst queuing, not long work.
      { maxWait: 60000, timeout: 120000 }
    )
    if (outcome.kind === "duplicate") {
      return {
        kind: "duplicate",
        submission: { id: outcome.duplicateOf },
        originAllowed: true,
        message,
        redirectUrl,
      }
    }
    const created = outcome.submission
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
    // Usage ledger (Phase 4, reporting): the row is written inside
    // the submission transaction above (DB-050), so it commits with
    // the submission — no best-effort write is needed here.
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

// AIM-021: claim one unit of an owner's daily AI budget BEFORE the
// model call, atomically. The cap is per OWNER (aiRequestsPerDay),
// but the counter rows stay per form (AiDailyUsage is keyed
// form + day — no schema change), so the claim sums today's calls
// across ALL of the owner's forms and increments this form's row.
// The whole check + increment runs inside one transaction serialized
// by a Postgres advisory lock on (owner, day): without it, two
// concurrent polls (worker + cron) both read usage < cap and both
// spend calls. A claimed unit is consumed even when the model call
// then fails — a down provider cannot retry the same rows
// unboundedly on every poll. Returns false when the owner's budget
// is exhausted (or the cap is 0).
async function claimOwnerAiCall(
  ownerId: string | undefined,
  formId: string,
  cap: number,
  today: Date
): Promise<boolean> {
  if (cap <= 0) return false
  const lockKey = `ai-daily:${ownerId ?? `form:${formId}`}:${today.toISOString().slice(0, 10)}`
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
      : [formId]
    const rows = await tx.aiDailyUsage.findMany({
      where: { formId: { in: formIds }, date: today },
      select: { calls: true },
    })
    const used = rows.reduce((sum, r) => sum + r.calls, 0)
    if (used >= cap) return false
    await tx.aiDailyUsage.upsert({
      where: { formId_date: { formId, date: today } },
      create: { formId, date: today, calls: 1 },
      update: { calls: { increment: 1 } },
    })
    return true
  })
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
      form: { aiEnabled: true, deletedAt: null },
    },
    include: { form: { select: { id: true, name: true, ownerId: true } } },
    orderBy: { createdAt: "asc" },
    take: limit,
  })

  // The daily cap is the form OWNER's aiRequestsPerDay from their
  // effective plan (Phase 4) — previously it was the global env default
  // for every form. The usage counter is keyed per form (AiDailyUsage
  // is form + day), but the CAP is enforced per owner: the claim sums
  // today's calls across all of the owner's forms (AIM-021), so an
  // owner with N AI-enabled forms gets the plan allowance once, not
  // N times. A suspended owner has null entitlements → cap 0
  // (skipped). A failed lookup (null) → the env default, so a
  // plans-module error never stops the rescore loop.
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
  const cappedOwners = new Set<string>()
  // AIM-029: one audit row per form the run touched (counts, outcome)
  // so a run that scores everything genuine still leaves a trace.
  const perForm = new Map<
    string,
    { ownerId: string; checked: number; markedSpam: number; skipped: number }
  >()
  function tally(
    formId: string,
    ownerId: string,
    field: "checked" | "markedSpam" | "skipped"
  ): void {
    const row = perForm.get(formId) ?? {
      ownerId,
      checked: 0,
      markedSpam: 0,
      skipped: 0,
    }
    row[field]++
    perForm.set(formId, row)
  }
  for (const submission of candidates) {
    const formId = submission.formId
    const ownerId = submission.form.ownerId
    const ownerKey = ownerId ?? `form:${formId}`
    if (cappedOwners.has(ownerKey)) {
      skipped++
      tally(formId, ownerId, "skipped")
      continue
    }
    const cap = await getOwnerCap(ownerId)
    const resolved = await getOwnerModel(ownerId)
    if (!resolved) {
      skipped++
      tally(formId, ownerId, "skipped")
      continue
    }
    // AIM-021: claim the owner's budget unit BEFORE the model call.
    // The claim sums today's calls across all of the owner's forms
    // and is atomic — two concurrent polls cannot both spend the
    // last unit. A failed model call still consumes its unit (the
    // catch below no longer increments), so a down provider cannot
    // retry the same rows unboundedly on every poll.
    const claimed = await claimOwnerAiCall(ownerId, formId, cap, today)
    if (!claimed) {
      cappedOwners.add(ownerKey)
      skipped++
      tally(formId, ownerId, "skipped")
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
      // The claimed budget unit stays consumed (AIM-021).
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
      tally(formId, submission.form.ownerId, "skipped")
      continue
    }
    // AIM-021: the budget unit was already claimed before the model
    // call (claimOwnerAiCall above) — no post-call increment here.
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
    tally(formId, submission.form.ownerId, "checked")
    if (isSpam) {
      markedSpam++
      tally(formId, submission.form.ownerId, "markedSpam")
    }
  }
  for (const [formId, counts] of perForm) {
    await logAudit({
      userId: counts.ownerId,
      action: AuditAction.CREATE,
      resourceType: AuditResource.FORM,
      resourceId: formId,
      detail: {
        event: "ai-rescore-run",
        checked: counts.checked,
        markedSpam: counts.markedSpam,
        skipped: counts.skipped,
      },
    })
  }
  return { checked, markedSpam, skipped }
}

// ---------------------------------------------------------------------------
// Inbox digest (Phase 12, Step 3; decoupled from AI in Phase 16, EML-093)
// ---------------------------------------------------------------------------
// Once per interval (the form's `digestIntervalHours`, else
// AI_DIGEST_INTERVAL_HOURS, default 24 = daily), the worker emails
// each digest-enabled form's owner a summary of the form's NEW
// submissions since the last digest. The digest is a notification
// preference (`Form.digestEnabled`), not an AI feature: when AI is
// on for the form and a model resolves, the model writes the
// summary; otherwise the digest is a plain list of the new
// submissions (no content ever reaches a model provider unless the
// owner opted into AI). The email goes through the outbox
// (EmailJobType.DIGEST) so delivery is retried like any other
// notification. A form with no new submissions gets no email, and
// the window only advances when a digest is actually enqueued.

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
  // EML-093: the digest is NOT gated on AI being configured anywhere
  // — a form with `digestEnabled` and no AI gets a plain digest (see
  // below). There is deliberately no `isAiConfigured` early return
  // here; the rescore job keeps its own.
  const defaultIntervalMs = getDigestIntervalHours(env) * 3_600_000

  // EML-093: the gate is the digest preference, not `aiEnabled`.
  // The due check is per form (each form has its own interval), so
  // the query only narrows to digest-enabled forms and the due
  // comparison runs in code below.
  const forms = await db.form.findMany({
    where: {
      digestEnabled: true,
      deletedAt: null,
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
    // Per-form due check (EML-093): `digestIntervalHours` overrides
    // the platform default; a form that never sent one is due.
    const intervalMs =
      form.digestIntervalHours != null
        ? form.digestIntervalHours * 3_600_000
        : defaultIntervalMs
    if (
      form.lastDigestAt !== null &&
      form.lastDigestAt.getTime() + intervalMs > Date.now()
    ) {
      skipped++
      continue
    }
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
    const digestInputs = submissions.map((s) => {
      const sender = getSubmissionSender(s.data)
      return {
        senderName: sender.name,
        senderEmail: sender.email,
        snippet: previewSubmissionText(s.data).slice(0, 200),
        receivedAt: s.createdAt,
      }
    })
    // EML-093: the AI summary is an enhancement, not a gate. AI
    // runs only when the form opted into it AND a model resolves
    // for the owner; otherwise the digest is plain (the owner still
    // gets notified — submission content goes to the owner, never
    // to a model provider, unless they opted in). A model call that
    // starts and then fails still skips the form (retry next run)
    // instead of silently downgrading a summary the owner expected.
    let summary: DigestSummary
    let aiSummary = false
    const resolved = form.aiEnabled ? await getOwnerModel(form.ownerId) : null
    if (resolved) {
      const callUsage: { current: AiCallUsage | null } = { current: null }
      try {
        summary = await generateDigest({
          model: resolved.model,
          formName: form.name,
          submissions: digestInputs,
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
      aiSummary = true
    } else {
      summary = buildPlainDigestSummary(form.name, digestInputs)
    }
    const now = new Date()
    // Enqueue first, then advance the window: a failed enqueue must
    // not move the window (those submissions would be lost), while a
    // failed window update only re-sends the same digest on the next
    // poll. (Same rule as the submission notifications: enqueue after
    // the save, never inside its transaction.) EML-093: the advance
    // is conditional on the enqueue actually creating the job — an
    // enqueue that reports 0 leaves the window (and the submissions)
    // for the next run.
    const enqueued = await enqueueDigest({
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
    if (enqueued === 0) {
      logger.error("digest enqueue created no job", { formId: form.id })
      skipped++
      continue
    }
    await db.form.update({
      where: { id: form.id },
      data: { lastDigestAt: now },
    })
    // AIM-029: one audit row per digest sent (form, submission count)
    // so a sent digest is visible in the audit log, not only in the
    // outbox EmailJob row. Renamed from `ai-digest-sent` in Phase 16
    // (EML-093): plain digests carry no AI summary — `aiSummary`
    // says which kind this one was.
    await logAudit({
      userId: form.ownerId,
      action: AuditAction.CREATE,
      resourceType: AuditResource.FORM,
      resourceId: form.id,
      detail: {
        event: "digest-sent",
        submissionCount: submissions.length,
        aiSummary,
      },
    })
    sent++
  }
  return { sent, skipped }
}
