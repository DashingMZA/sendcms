import { createHash, randomUUID } from "node:crypto"
import { db } from "@/lib/db"
import { ApiError } from "@/lib/api/error"
import { normalizeDomain } from "@/lib/services/domain-service"
import { verifyTurnstileToken } from "@/lib/services/turnstile"
import { getSubmissionSender } from "@/lib/submission-display"
import {
  HONEYPOT_FIELD,
  type SubmitBodyInput,
} from "@/lib/validators/submission"
import {
  Prisma,
  SubmissionStatus,
  SubmissionEventType,
} from "@/generated/prisma/client"
import type { FormField } from "@/generated/prisma/client"

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
// Inbox dashboard (Phase 7). Admin-side reads and status changes.
// Isolation rule: a Submission has no ownerId of its own — every query
// scopes through its Form (form.ownerId = the viewer). A submission
// whose form belongs to someone else is invisible, not just forbidden.

export const INBOX_PAGE_SIZE = 20

export type InboxTab =
  "all" | "unread" | "read" | "starred" | "archived" | "spam"

export type InboxAction =
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "archive"
  | "restore"
  | "spam"
  | "not-spam"

export type InboxFilters = {
  tab?: InboxTab
  formId?: string
  originDomain?: string
  search?: string
  /** Inclusive, YYYY-MM-DD. */
  from?: string
  /** Inclusive, YYYY-MM-DD. */
  to?: string
  page?: number
}

/** Sender details pulled out of the submission's field values. Keys are
    matched case-insensitively; anything else falls back to null. */
export { getSubmissionSender } from "@/lib/submission-display"

type StatusTransition = {
  status: SubmissionStatus
  event: SubmissionEventType
}

/** Maps an inbox action to its target status + event, or null when the
    action is a no-op for the current status (idempotent — the caller
    returns the submission unchanged and writes no event). Archived and
    spam submissions must be restored before any other action. */
export function resolveStatusAction(
  action: InboxAction,
  current: SubmissionStatus
): StatusTransition | null {
  switch (action) {
    case "read":
      return current === SubmissionStatus.NEW
        ? { status: SubmissionStatus.READ, event: SubmissionEventType.READ }
        : null
    case "unread":
      return current === SubmissionStatus.READ ||
        current === SubmissionStatus.STARRED
        ? { status: SubmissionStatus.NEW, event: SubmissionEventType.UNREAD }
        : null
    case "star":
      return current === SubmissionStatus.NEW ||
        current === SubmissionStatus.READ
        ? {
            status: SubmissionStatus.STARRED,
            event: SubmissionEventType.STARRED,
          }
        : null
    case "unstar":
      return current === SubmissionStatus.STARRED
        ? {
            status: SubmissionStatus.READ,
            event: SubmissionEventType.UNSTARRED,
          }
        : null
    case "archive":
      return current === SubmissionStatus.NEW ||
        current === SubmissionStatus.READ ||
        current === SubmissionStatus.STARRED
        ? {
            status: SubmissionStatus.ARCHIVED,
            event: SubmissionEventType.ARCHIVED,
          }
        : null
    case "restore":
      return current === SubmissionStatus.ARCHIVED ||
        current === SubmissionStatus.SPAM
        ? {
            status: SubmissionStatus.READ,
            event: SubmissionEventType.RESTORED,
          }
        : null
    case "spam":
      return current === SubmissionStatus.NEW ||
        current === SubmissionStatus.READ ||
        current === SubmissionStatus.STARRED
        ? {
            status: SubmissionStatus.SPAM,
            event: SubmissionEventType.MARKED_SPAM,
          }
        : null
    case "not-spam":
      return current === SubmissionStatus.SPAM
        ? {
            status: SubmissionStatus.READ,
            event: SubmissionEventType.RESTORED,
          }
        : null
  }
}

type InboxRow = {
  id: string
  data: Prisma.JsonValue
  status: SubmissionStatus
  originDomain: string
  ipAddress: string | null
  userAgent: string | null
  pageUrl: string | null
  createdAt: Date
  updatedAt: Date
  formId: string
  formName: string
}

export type InboxListItem = InboxRow & {
  sender: { name: string | null; email: string | null }
}

export type InboxCounts = Record<InboxTab, number>

export type InboxListResult = {
  items: InboxListItem[]
  total: number
  page: number
  pageSize: number
  counts: InboxCounts
}

function tabStatuses(tab: InboxTab): SubmissionStatus[] | null {
  switch (tab) {
    case "all":
      return [
        SubmissionStatus.NEW,
        SubmissionStatus.READ,
        SubmissionStatus.STARRED,
      ]
    case "unread":
      return [SubmissionStatus.NEW]
    case "read":
      return [SubmissionStatus.READ]
    case "starred":
      return [SubmissionStatus.STARRED]
    case "archived":
      return [SubmissionStatus.ARCHIVED]
    case "spam":
      return [SubmissionStatus.SPAM]
  }
}

function buildInboxWhere(
  userId: string,
  filters: InboxFilters,
  includeStatus: boolean
): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`f."ownerId" = ${userId}`]
  if (includeStatus) {
    const statuses = tabStatuses(filters.tab ?? "all")
    if (statuses) {
      parts.push(Prisma.sql`s.status = ANY(${statuses}::"SubmissionStatus"[])`)
    }
  }
  if (filters.formId) {
    parts.push(Prisma.sql`s."formId" = ${filters.formId}`)
  }
  if (filters.originDomain) {
    parts.push(Prisma.sql`s."originDomain" = ${filters.originDomain}`)
  }
  if (filters.from) {
    parts.push(Prisma.sql`s."createdAt" >= ${filters.from}::timestamptz`)
  }
  if (filters.to) {
    // Inclusive end of day.
    parts.push(
      Prisma.sql`s."createdAt" < (${filters.to}::date + interval '1 day')`
    )
  }
  const search = filters.search?.trim()
  if (search) {
    const like = `%${search}%`
    parts.push(
      Prisma.sql`(s."originDomain" ILIKE ${like} OR s."pageUrl" ILIKE ${like} OR s."data"::text ILIKE ${like})`
    )
  }
  return Prisma.join(parts, " AND ")
}

const INBOX_SELECT = Prisma.sql`
  s.id, s.data, s.status, s."originDomain", s."ipAddress", s."userAgent",
  s."pageUrl", s."createdAt", s."updatedAt",
  f.id AS "formId", f.name AS "formName"
  FROM "Submission" s
  JOIN "Form" f ON f.id = s."formId"
`

export async function listSubmissionsForUser(
  userId: string,
  filters: InboxFilters
): Promise<InboxListResult> {
  const page = Math.max(1, filters.page ?? 1)
  const offset = (page - 1) * INBOX_PAGE_SIZE

  const [rows, totalRows, countRows] = await Promise.all([
    db.$queryRaw<InboxRow[]>(Prisma.sql`
      SELECT ${INBOX_SELECT}
      WHERE ${buildInboxWhere(userId, filters, true)}
      ORDER BY s."createdAt" DESC
      LIMIT ${INBOX_PAGE_SIZE} OFFSET ${offset}
    `),
    db.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n
      FROM "Submission" s
      JOIN "Form" f ON f.id = s."formId"
      WHERE ${buildInboxWhere(userId, filters, true)}
    `),
    db.$queryRaw<{ status: SubmissionStatus; n: number }[]>(Prisma.sql`
      SELECT s.status, COUNT(*)::int AS n
      FROM "Submission" s
      JOIN "Form" f ON f.id = s."formId"
      WHERE ${buildInboxWhere(userId, filters, false)}
      GROUP BY s.status
    `),
  ])

  const byStatus = new Map<SubmissionStatus, number>()
  for (const row of countRows) byStatus.set(row.status, row.n)
  const at = (status: SubmissionStatus) => byStatus.get(status) ?? 0
  const counts: InboxCounts = {
    all:
      at(SubmissionStatus.NEW) +
      at(SubmissionStatus.READ) +
      at(SubmissionStatus.STARRED),
    unread: at(SubmissionStatus.NEW),
    read: at(SubmissionStatus.READ),
    starred: at(SubmissionStatus.STARRED),
    archived: at(SubmissionStatus.ARCHIVED),
    spam: at(SubmissionStatus.SPAM),
  }

  return {
    items: rows.map((row) => ({
      ...row,
      sender: getSubmissionSender(row.data),
    })),
    total: totalRows[0]?.n ?? 0,
    page,
    pageSize: INBOX_PAGE_SIZE,
    counts,
  }
}

export type InboxSubmissionDetail = Prisma.SubmissionGetPayload<{
  include: {
    form: { select: { id: true; name: true } }
    events: {
      include: { actor: { select: { name: true; email: true } } }
    }
  }
}>

export async function getSubmissionForUser(
  userId: string,
  submissionId: string
): Promise<InboxSubmissionDetail> {
  const submission = await db.submission.findFirst({
    where: { id: submissionId, form: { ownerId: userId } },
    include: {
      form: { select: { id: true, name: true } },
      events: {
        orderBy: { createdAt: "desc" },
        include: { actor: { select: { name: true, email: true } } },
      },
    },
  })
  if (!submission) {
    throw new ApiError("Submission not found.", 404)
  }
  return submission
}

async function applyStatusAction(
  tx: Prisma.TransactionClient,
  submission: { id: string; status: SubmissionStatus },
  action: InboxAction,
  actorId: string
): Promise<{ changed: boolean; status: SubmissionStatus }> {
  const transition = resolveStatusAction(action, submission.status)
  if (!transition) {
    return { changed: false, status: submission.status }
  }
  await tx.submission.update({
    where: { id: submission.id },
    data: { status: transition.status },
  })
  await tx.submissionEvent.create({
    data: {
      type: transition.event,
      detail: {
        action,
        from: submission.status,
        to: transition.status,
      },
      submissionId: submission.id,
      actorId,
    },
  })
  return { changed: true, status: transition.status }
}

export async function updateSubmissionStatusForUser(
  userId: string,
  submissionId: string,
  action: InboxAction
): Promise<{ id: string; status: SubmissionStatus; changed: boolean }> {
  return db.$transaction(async (tx) => {
    const submission = await tx.submission.findFirst({
      where: { id: submissionId, form: { ownerId: userId } },
      select: { id: true, status: true },
    })
    if (!submission) {
      throw new ApiError("Submission not found.", 404)
    }
    const result = await applyStatusAction(tx, submission, action, userId)
    return { id: submission.id, ...result }
  })
}

export async function bulkUpdateSubmissionsForUser(
  userId: string,
  submissionIds: string[],
  action: InboxAction
): Promise<{ updated: number; skipped: number }> {
  return db.$transaction(async (tx) => {
    const submissions = await tx.submission.findMany({
      where: {
        id: { in: submissionIds },
        form: { ownerId: userId },
      },
      select: { id: true, status: true },
    })
    let updated = 0
    let skipped = 0
    for (const submission of submissions) {
      const result = await applyStatusAction(tx, submission, action, userId)
      if (result.changed) updated++
      else skipped++
    }
    // Ids that don't exist or belong to someone else are skipped
    // silently — the caller never learns whether they exist.
    skipped += submissionIds.length - submissions.length
    return { updated, skipped }
  })
}

export async function deleteSubmissionForUser(
  userId: string,
  submissionId: string
): Promise<void> {
  const deleted = await db.submission.deleteMany({
    where: { id: submissionId, form: { ownerId: userId } },
  })
  if (deleted.count === 0) {
    throw new ApiError("Submission not found.", 404)
  }
}

export async function getUnreadSubmissionCountForUser(
  userId: string
): Promise<number> {
  return db.submission.count({
    where: { status: SubmissionStatus.NEW, form: { ownerId: userId } },
  })
}
