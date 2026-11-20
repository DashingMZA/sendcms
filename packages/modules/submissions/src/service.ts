import { createHash, randomUUID } from "node:crypto"
import {
  Prisma,
  SubmissionEventType,
  SubmissionStatus,
  db,
} from "@sendcms/database"
import type { FormField } from "@sendcms/database"

import { ApiError } from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"
import {
  getAiModel,
  getSpamThreshold,
  isAiConfigured,
  rescoreSpam,
} from "@sendcms/ai"
import { normalizeDomain } from "@sendcms/domains"
import { verifyTurnstileToken } from "./turnstile"
import { enqueueSubmissionNotifications } from "@sendcms/notifications"
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
  if (!isAiConfigured(env)) return { checked: 0, markedSpam: 0, skipped: 0 }
  const threshold = getSpamThreshold(env)
  const cap = getAiDailyCallCap(env)
  const model = getAiModel(env)
  const today = startOfUtcDay()

  const candidates = await db.submission.findMany({
    where: {
      status: SubmissionStatus.NEW,
      aiScoredAt: null,
      form: { aiEnabled: true },
    },
    include: { form: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
    take: limit,
  })

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
    const usage = await db.aiDailyUsage.findUnique({
      where: { formId_date: { formId, date: today } },
    })
    if ((usage?.calls ?? 0) >= cap) {
      cappedForms.add(formId)
      skipped++
      continue
    }
    let verdict
    try {
      verdict = await rescoreSpam({
        model,
        formName: submission.form.name,
        data: submission.data as Record<string, unknown>,
      })
    } catch (err) {
      // A failed model call is retried on a later poll (the row stays
      // unscored) — it must not fail the batch or lose the submission.
      logger.error("ai rescore failed", { error: err, formId })
      skipped++
      continue
    }
    await db.aiDailyUsage.upsert({
      where: { formId_date: { formId, date: today } },
      create: { formId, date: today, calls: 1 },
      update: { calls: { increment: 1 } },
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
