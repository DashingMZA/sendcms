import { NextRequest, NextResponse, after } from "next/server"
import { processEmailOutbox } from "@sendcms/notifications"
import { createLogger } from "@sendcms/observability"
import { submitForm, type SubmitResult } from "@sendcms/submissions"
import { isVerifiedOrigin } from "@sendcms/domains"
import {
  ApiError,
  getEffectiveOrigin,
  handleApiError,
  methodNotAllowed,
  validationErrorMessage,
} from "@sendcms/api-client"
import {
  SubmitBodySchema,
  formDataToSubmitBody,
  type SubmitBodyInput,
} from "@sendcms/submissions/validators"

const logger = createLogger("api")

// Public submission API — no session, no cookies. Authorization is the
// Origin allowlist (enforced in the service): the submitting site must be
// a VERIFIED domain linked to the form. CORS headers are only echoed for
// origins that passed that check, so a rejected origin cannot read the
// response — including error responses. Pre-service errors (route-level
// validation, the size guard, malformed JSON, the form-lookup 404) never
// reach that check, so they echo CORS for any VERIFIED domain instead
// (SDK-015/SDK-022); a non-verified origin still gets no CORS headers.
//
// Two content types are accepted:
//   - application/json (the SDK and direct REST clients)
//   - application/x-www-form-urlencoded / multipart/form-data (a native
//     <form action="…/submit" method="POST"> with no JavaScript). For
//     form posts the response is a 303 redirect instead of JSON: success
//     goes to the form's redirectUrl, else the referring page with
//     ?cms_submitted=1; errors go to the referring page with
//     ?cms_error=<message> (JSON when there is no referer to go back to).

function publicCorsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  }
}

function getClientIp(req: NextRequest): string | null {
  // In production the platform (Cloudflare / Vercel) sets these; the
  // first x-forwarded-for entry is the client. Never trust a later entry.
  const forwarded = req.headers.get("x-forwarded-for")
  if (forwarded) return forwarded.split(",")[0].trim() || null
  return (
    req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? null
  )
}

export async function OPTIONS(req: NextRequest) {
  // Preflight carries no body, so the form is unknown here. Per the
  // SDK-021 decision (user, 2026-11-24), only origins whose host is a
  // VERIFIED domain get CORS headers — any other origin gets a bare 204
  // with no Access-Control-Allow-Origin, so the browser blocks the
  // request. No Access-Control-Allow-Credentials is ever sent.
  const origin = getEffectiveOrigin(req)
  if (!origin) return new NextResponse(null, { status: 204 })
  if (!(await isVerifiedOrigin(origin))) {
    return new NextResponse(null, { status: 204 })
  }
  return new NextResponse(null, {
    status: 204,
    headers: publicCorsHeaders(origin),
  })
}

export async function POST(req: NextRequest) {
  const origin = getEffectiveOrigin(req)
  const referer = req.headers.get("referer")
  const contentType = req.headers.get("content-type") ?? ""
  const isFormPost =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  try {
    const parsed = await parseSubmitBody(req, isFormPost, referer)
    const result = await submitForm(parsed, {
      origin,
      ip: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
    })
    if (result.kind === "created") scheduleOutboxDelivery()
    return submitSuccessResponse(result, isFormPost, referer, origin)
  } catch (err) {
    // await, not bare return: a bare `return submitErrorResponse()`
    // would let its rejection skip this catch and surface as a 500.
    return await submitErrorResponse(err, { origin, isFormPost, referer })
  }
}

// Parses + validates the request body: the 64,000-byte size guard, the
// form-data / JSON split, the malformed-JSON 400, the referer
// pageUrl default for no-JS forms, and the Zod 422.
async function parseSubmitBody(
  req: NextRequest,
  isFormPost: boolean,
  referer: string | null
): Promise<SubmitBodyInput> {
  // Cheap size guard before parsing: the service also caps the
  // sanitized payload after validation.
  const contentLength = req.headers.get("content-length")
  if (contentLength && Number(contentLength) > 64_000) {
    throw new ApiError("Submission is too large.", 413)
  }
  const rawBody = isFormPost
    ? formDataToSubmitBody(await req.formData())
    : await req.json().catch(() => null)
  // SDK-017/SDK-023: a syntactically invalid JSON body is a 400 with
  // a clean message. It used to be coerced to {} and fail Zod with a
  // raw schema dump ("Invalid input: expected string, received
  // undefined; …") that never said "malformed JSON".
  if (rawBody === null) {
    throw new ApiError("Malformed JSON body.", 400)
  }
  // A no-JS form has no pageUrl field; the referer is the page it
  // was submitted from.
  if (
    isFormPost &&
    typeof rawBody === "object" &&
    rawBody !== null &&
    !("pageUrl" in rawBody) &&
    referer
  ) {
    ;(rawBody as Record<string, unknown>).pageUrl = referer
  }
  const parsed = SubmitBodySchema.safeParse(rawBody)
  if (!parsed.success) {
    throw new ApiError(validationErrorMessage(parsed.error), 422)
  }
  return parsed.data
}

// Notifications are already queued (the service enqueues after the
// durable save). Attempt delivery now, after the response is sent —
// failures stay queued for the cron worker to retry.
function scheduleOutboxDelivery(): void {
  after(async () => {
    try {
      await processEmailOutbox({ limit: 25 })
    } catch (err) {
      logger.error("outbox run failed", { error: err })
    }
  })
}

// Success: a form post 303-redirects (to the form's redirectUrl, else
// the referring page with ?cms_submitted=1); anything else gets the
// JSON body, 201 for a new submission, 200 for a deduped retry.
function submitSuccessResponse(
  result: SubmitResult,
  isFormPost: boolean,
  referer: string | null,
  origin: string | null
): NextResponse {
  if (isFormPost) {
    const target =
      result.redirectUrl ?? withQuery(referer, "cms_submitted", "1")
    if (target) {
      return NextResponse.redirect(target, { status: 303 })
    }
    // No referer and no redirectUrl: fall through to JSON.
  }
  const headers = origin ? publicCorsHeaders(origin) : undefined
  const payload = {
    ok: true,
    id: result.kind === "honeypot" ? result.fakeId : result.submission.id,
    message: result.message,
    redirectUrl: result.redirectUrl,
  }
  return NextResponse.json(payload, {
    status: result.kind === "duplicate" ? 200 : 201,
    headers,
  })
}

type SubmitErrorContext = {
  origin: string | null
  isFormPost: boolean
  referer: string | null
}

// Failure: a form post goes back to the page it came from with the
// error in the query string (JSON only when there is nowhere to go
// back to); anything else gets the JSON error, with CORS per the
// origin decision below and a Retry-After when the service says how
// long to wait (SDK-019).
async function submitErrorResponse(
  err: unknown,
  ctx: SubmitErrorContext
): Promise<NextResponse> {
  // SRC-237: the service used to report monthly quota exhaustion as
  // 402 ("Payment Required"), which no client handles and the
  // documented ApiError vocabulary does not include. The service now
  // emits 429 directly; this remap stays as a backstop in case a 402
  // ever slips through again — same message, same originAllowed flag,
  // so the CORS behaviour is unchanged.
  let error: unknown = err
  if (error instanceof ApiError && error.status === 402) {
    const quotaError = new ApiError(error.message, 429)
    quotaError.originAllowed = error.originAllowed
    error = quotaError
  }
  if (ctx.isFormPost && ctx.referer) {
    const message =
      error instanceof ApiError ? error.message : "Internal server error"
    const target = withQuery(ctx.referer, "cms_error", message)
    if (target) {
      return NextResponse.redirect(target, { status: 303 })
    }
  }
  const allowedOrigin = await resolveErrorOrigin(error, ctx.origin)
  // SDK-019: rate-limit throws carry `retryAfterSeconds` (see
  // submitForm's fail()) — surface it as a Retry-After header so
  // clients and proxies back off for exactly the right wait.
  const retryAfter =
    error instanceof ApiError
      ? (error as ApiError & { retryAfterSeconds?: number }).retryAfterSeconds
      : undefined
  const headers = {
    ...(allowedOrigin ? publicCorsHeaders(allowedOrigin) : undefined),
    ...(retryAfter !== undefined ? { "Retry-After": String(retryAfter) } : {}),
  }
  return handleApiError(error, undefined, headers)
}

// CORS on errors. The service sets originAllowed on the errors it
// throws (true = verified + linked to this form, false = rejected
// for this form) — that decision is respected as-is. Pre-service
// errors never reach the service's allowlist check, so
// originAllowed is unset: the route-level Zod 422, the 413 size
// guard, the malformed-JSON 400, and the form-lookup 404. For
// those (SDK-015/SDK-022), echo CORS when the origin's host is a
// VERIFIED domain — the SDK-021 owner decision is "no CORS
// headers for non-verified origins", and a verified origin must be
// able to read the validation message. The lookup is best-effort:
// if it fails (e.g. the DB is down) the error goes out without
// CORS headers rather than failing the error path itself.
// Errors use the same public CORS headers as successes (not the
// legacy admin corsHeaders — this endpoint has no GET/PATCH and
// takes no Authorization header).
async function resolveErrorOrigin(
  error: unknown,
  origin: string | null
): Promise<string | undefined> {
  if (!origin) return undefined
  if (error instanceof ApiError && error.originAllowed === true) {
    return origin
  }
  if (error instanceof ApiError && error.originAllowed === false) {
    // The service rejected this origin for this form — no CORS
    // headers, as before.
    return undefined
  }
  try {
    if (await isVerifiedOrigin(origin)) return origin
  } catch {
    // Fail closed: no CORS headers on the error.
  }
  return undefined
}

/** Returns url with one query param set, or null when the url is not
    a parseable absolute URL. */
function withQuery(
  url: string | null,
  key: string,
  value: string
): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    parsed.searchParams.set(key, value)
    return parsed.toString()
  } catch {
    return null
  }
}

// SDK-031: wrong-method requests get a JSON 405 with an Allow
// header, not Next.js's empty 405.
export const GET = () => methodNotAllowed(["POST", "OPTIONS"])
export const PUT = () => methodNotAllowed(["POST", "OPTIONS"])
export const PATCH = () => methodNotAllowed(["POST", "OPTIONS"])
export const DELETE = () => methodNotAllowed(["POST", "OPTIONS"])
