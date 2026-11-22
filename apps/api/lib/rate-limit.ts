import { NextRequest, NextResponse } from "next/server"
import {
  checkAdminApiRateLimit,
  checkAuthSignInRateLimit,
} from "@sendcms/security"

// Route-level rate-limit enforcement for the admin API + auth
// sign-in (Admin Control Plane, Phase 9; closes ADR 0008 §6). The
// counting lives in @sendcms/security (DB-backed fixed windows,
// fail-open); this file only adapts it to route handlers: it pulls
// the client IP off the request and turns a denial into the 429
// response (with Retry-After) the handler returns early. The public
// submit path and the MCP endpoint keep their own limiters and are
// NOT wrapped here.
//
// Every /api/v1/admin/* handler calls enforceAdminApiRateLimit right
// after its session check; the auth handler calls
// enforceAuthSignInRateLimit for POST /api/auth/sign-in/email only.

// Same client-IP resolution as the public submit route: the platform
// (Cloudflare / Vercel) sets these; the first x-forwarded-for entry
// is the client. Never trust a later entry.
export function getClientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get("x-forwarded-for")
  if (forwarded) return forwarded.split(",")[0].trim() || null
  return (
    req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? null
  )
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

// Auth sign-in (POST /api/auth/sign-in/email only): per-IP + per-email
// buckets. The email comes from a cloned body so the Better Auth
// handler still sees the original request; an unparsable body still
// gets the IP bucket. Returns the 429 response when limited, null
// otherwise. GETs (OAuth callbacks, session reads) are not limited.
export async function enforceAuthSignInRateLimit(
  req: NextRequest
): Promise<NextResponse | null> {
  let email: string | null = null
  try {
    const body = (await req.clone().json()) as unknown
    if (
      typeof body === "object" &&
      body !== null &&
      "email" in body &&
      typeof (body as { email: unknown }).email === "string"
    ) {
      email = (body as { email: string }).email
    }
  } catch {
    email = null
  }
  const result = await checkAuthSignInRateLimit({
    ip: getClientIp(req),
    email,
  })
  if (result.allowed) return null
  return tooManyRequests(result.retryAfterSeconds ?? 60)
}
