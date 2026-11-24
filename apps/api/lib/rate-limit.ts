import { NextRequest, NextResponse } from "next/server"
import { RateLimitScope } from "@sendcms/database"
import {
  checkAdminApiRateLimit,
  checkAuthEmailRateLimit,
  checkAuthSignInRateLimit,
  checkAuthSignUpRateLimit,
  checkRateLimit,
  checkSendReplyRateLimit,
  checkTestEmailRateLimit,
  resolveClientIp,
} from "@sendcms/security"
import type { AuthEmailRateLimitKind } from "@sendcms/security"

// Route-level rate-limit enforcement for the admin API + auth
// (Admin Control Plane, Phase 9; closes ADR 0008 §6) and the
// email-sending routes (Phase 16, Wave 1: SEC-008 / SEC-203 /
// EML-003). The counting lives in @sendcms/security (DB-backed
// sliding-window-minute limiter, fail-open); this file only adapts it
// to route handlers: it pulls the client IP off the request and turns
// a denial into the 429 response (with Retry-After) the handler
// returns early. The public submit path and the MCP endpoint keep
// their own limiters and are NOT wrapped here.
//
// Every /api/v1/admin/* handler calls enforceAdminApiRateLimit right
// after its session check; the auth handler gates sign-in, sign-up,
// password-reset / verification-mail / OAuth initiation, and the
// test-email / send-reply routes gate per-user + per-resource.

// Client IP (SEC-204): `X-Forwarded-For` is trusted ONLY from a
// configured trusted proxy (TRUSTED_PROXY_IPS — see
// @sendcms/security `resolveClientIp`); otherwise the direct peer IP
// (NextRequest.ip) is the client, and a request with neither buckets
// as "unknown". Never trust a later XFF entry.
export function getClientIp(req: NextRequest): string | null {
  const peerIp = (req as NextRequest & { ip?: string }).ip ?? null
  return resolveClientIp(req.headers, peerIp)
}

function tooManyRequests(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    {
      error: `Too many requests. Please try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}.`,
    },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    }
  )
}

// Admin API: call after the session check, before the service call.
// Returns the 429 response when the caller is over the limit, null
// when the request may proceed. A limiter failure never blocks: the
// core fails open, so this returns null.
export async function enforceAdminApiRateLimit(
  req: NextRequest,
  userId: string
): Promise<NextResponse | null> {
  const result = await checkAdminApiRateLimit({
    userId,
    ip: getClientIp(req),
  })
  if (result.allowed) return null
  return tooManyRequests(result.retryAfterSeconds ?? 60)
}

// The email address out of a cloned auth body, so the Better Auth
// handler still sees the original request; an unparsable body still
// gets the IP bucket.
async function readEmailFromBody(req: NextRequest): Promise<string | null> {
  try {
    const body = (await req.clone().json()) as unknown
    if (
      typeof body === "object" &&
      body !== null &&
      "email" in body &&
      typeof (body as { email: unknown }).email === "string"
    ) {
      return (body as { email: string }).email
    }
  } catch {
    return null
  }
  return null
}

// Customer checkout (BIL-018): per-user, per-hour. Each checkout
// creates provider-side objects (a Stripe Price + Session, or a
// PayPal Product + Plan + Subscription attempt) at no cost to the
// caller, so an uncapped route is unbounded provider-object creation.
// 10 checkouts an hour is generous for a human retrying a failed
// payment; a flood past it gets 429 + Retry-After.
export async function enforceBillingCheckoutRateLimit(
  req: NextRequest,
  userId: string
): Promise<NextResponse | null> {
  const result = await checkRateLimit({
    scope: RateLimitScope.ADMIN_API,
    subject: `billing-checkout:user:${userId}`,
    minuteLimit: 10,
    hourLimit: 10,
  })
  if (result.allowed) return null
  return tooManyRequests(result.retryAfterSeconds ?? 60)
}

// Public billing webhooks (BIL-008): per-IP, per-provider endpoint.
// PayPal verification is not local — every delivery costs two outbound
// PayPal API calls (OAuth token + verify-webhook-signature) — so an
// uncapped public endpoint is an outbound-call amplifier; the other
// providers' local verifications still deserve a flood cap. 60/min
// per IP is far above legitimate provider redelivery volume. The
// bucket reuses the ADMIN_API scope with a namespaced subject (the
// scope enum cannot gain a value without a schema change); the
// subject keeps these buckets disjoint from admin-API buckets.
export async function enforceBillingWebhookRateLimit(
  req: NextRequest,
  provider: string
): Promise<NextResponse | null> {
  const ip = getClientIp(req) ?? "unknown"
  const result = await checkRateLimit({
    scope: RateLimitScope.ADMIN_API,
    subject: `billing-webhook:${provider.toLowerCase()}:ip:${ip}`,
    minuteLimit: 60,
    hourLimit: 600,
  })
  if (result.allowed) return null
  return tooManyRequests(result.retryAfterSeconds ?? 60)
}

// Auth sign-in (POST /api/auth/sign-in/email only): per-IP + per-email
// buckets. GETs (OAuth callbacks, session reads) are not limited.
export async function enforceAuthSignInRateLimit(
  req: NextRequest
): Promise<NextResponse | null> {
  const result = await checkAuthSignInRateLimit({
    ip: getClientIp(req),
    email: await readEmailFromBody(req),
  })
  if (result.allowed) return null
  return tooManyRequests(result.retryAfterSeconds ?? 60)
}

// Auth sign-up (POST /api/auth/sign-up/email): per-IP + per-email
// buckets, on separate subjects from sign-in (SEC-008 / SEC-203).
export async function enforceAuthSignUpRateLimit(
  req: NextRequest
): Promise<NextResponse | null> {
  const result = await checkAuthSignUpRateLimit({
    ip: getClientIp(req),
    email: await readEmailFromBody(req),
  })
  if (result.allowed) return null
  return tooManyRequests(result.retryAfterSeconds ?? 60)
}

// Auth email actions (SEC-008 / EML-003): forget-password /
// reset-password ("reset"), send-verification-email ("verify"), and
// OAuth initiation ("social"). Each kind has its own per-IP (+
// per-email where an email is supplied) buckets.
export async function enforceAuthEmailRateLimit(
  req: NextRequest,
  kind: AuthEmailRateLimitKind = "reset"
): Promise<NextResponse | null> {
  const result = await checkAuthEmailRateLimit({
    ip: getClientIp(req),
    email: await readEmailFromBody(req),
    kind,
  })
  if (result.allowed) return null
  return tooManyRequests(result.retryAfterSeconds ?? 60)
}

// Test-email (POST /api/v1/forms/[formId]/test-email): per-user +
// per-form buckets (EML-003). Call after the session check. No IP is
// involved — the caller is authenticated, so the user + form keys are
// the buckets.
export async function enforceTestEmailRateLimit(
  userId: string,
  formId: string
): Promise<NextResponse | null> {
  const result = await checkTestEmailRateLimit({ userId, formId })
  if (result.allowed) return null
  return tooManyRequests(result.retryAfterSeconds ?? 60)
}

// Send-reply (POST /api/v1/inbox/[id]/ai/send-reply): per-user +
// per-submission buckets (EML-003). Call after the session check.
export async function enforceSendReplyRateLimit(
  userId: string,
  submissionId: string
): Promise<NextResponse | null> {
  const result = await checkSendReplyRateLimit({ userId, submissionId })
  if (result.allowed) return null
  return tooManyRequests(result.retryAfterSeconds ?? 60)
}

// Customer AI settings (AIM-002): per-user. None of the customer AI
// routes had any limit, while the admin AI routes do — one user could
// fire unlimited 85-second live provider probes (test/test-browser)
// and unlimited key saves. The general budget covers save / enable /
// disable / billing-mode (cheap DB writes); the test routes make live
// provider calls, so they get the tighter budget on their own subject
// (a test burst must not eat the general budget, or vice versa). The
// bucket reuses the ADMIN_API scope with a namespaced subject, like
// the billing limiters above — the scope enum cannot gain a value
// without a schema change.
export const CUSTOMER_AI_MINUTE_LIMIT = 60
export const CUSTOMER_AI_HOUR_LIMIT = 600
export const CUSTOMER_AI_TEST_MINUTE_LIMIT = 5
export const CUSTOMER_AI_TEST_HOUR_LIMIT = 20

export async function enforceCustomerAiRateLimit(
  req: NextRequest,
  userId: string,
  testRoute = false
): Promise<NextResponse | null> {
  const result = await checkRateLimit({
    scope: RateLimitScope.ADMIN_API,
    subject: testRoute
      ? `customer-ai-test:user:${userId}`
      : `customer-ai:user:${userId}`,
    minuteLimit: testRoute
      ? CUSTOMER_AI_TEST_MINUTE_LIMIT
      : CUSTOMER_AI_MINUTE_LIMIT,
    hourLimit: testRoute ? CUSTOMER_AI_TEST_HOUR_LIMIT : CUSTOMER_AI_HOUR_LIMIT,
  })
  if (result.allowed) return null
  return tooManyRequests(result.retryAfterSeconds ?? 60)
}
