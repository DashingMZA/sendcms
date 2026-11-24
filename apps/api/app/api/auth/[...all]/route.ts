import { NextRequest, NextResponse } from "next/server"
import { betterAuth } from "@/lib/auth"
import {
  enforceAuthEmailRateLimit,
  enforceAuthSignInRateLimit,
  enforceAuthSignUpRateLimit,
} from "@/lib/rate-limit"
import { getEffectiveOrigin, normalizeOrigin } from "@sendcms/api-client"
import { toNextJsHandler } from "@sendcms/auth"

// Better Auth handler — serves /api/auth/* (incl. /callback/google).
// The Google redirect URI stays `<APP_URL>/api/auth/callback/google`,
// same as before, so no Google Cloud Console change is needed.
//
// Cross-origin auth (Phase 7): the dashboard app's pages run on a
// different origin than this api app, so the browser auth client posts
// cross-origin. Better Auth validates origins (trustedOrigins) but
// never emits CORS response headers, and Next.js auto-answers a
// preflight OPTIONS with 204 + no CORS headers when a route doesn't
// export OPTIONS — either gap makes the browser fail the request with
// "Failed to fetch". So this route exports OPTIONS and echoes the
// Access-Control headers on every response, but only for origins
// Better Auth already trusts (trustedOrigins + baseURL). The session
// cookie is credentialed, so the origin is echoed exactly, never "*".
// (Same shape as the public submit route's preflight + CORS echo.)

const handlers = toNextJsHandler(betterAuth)

/** The request origin, but only when Better Auth already trusts it. */
function trustedOrigin(req: NextRequest): string | null {
  const origin = getEffectiveOrigin(req)
  if (!origin) return null
  const allowed = new Set(
    [...(betterAuth.options.trustedOrigins ?? []), betterAuth.options.baseURL]
      .filter((o): o is string => typeof o === "string" && o.length > 0)
      .map((o) => normalizeOrigin(o))
  )
  return allowed.has(normalizeOrigin(origin)) ? origin : null
}

function authCorsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  }
}

export async function OPTIONS(req: NextRequest) {
  const origin = trustedOrigin(req)
  return new NextResponse(null, {
    status: 204,
    headers: origin ? authCorsHeaders(origin) : {},
  })
}

async function withCors(
  req: NextRequest,
  handler: (req: NextRequest) => Promise<Response>
): Promise<Response> {
  const response = await handler(req)
  const origin = trustedOrigin(req)
  if (origin) {
    for (const [name, value] of Object.entries(authCorsHeaders(origin))) {
      response.headers.set(name, value)
    }
  }
  return response
}

export const GET = (req: NextRequest) => withCors(req, handlers.GET)
export const POST = (req: NextRequest) =>
  withCors(req, async (r) => {
    // Rate-limited auth POSTs (Phase 16, Wave 1: SEC-008 / SEC-203 /
    // EML-003), before Better Auth sees the request. Every endpoint
    // that creates accounts or sends mail is gated per-IP + per-email:
    // sign-in, sign-up, password reset (forget / request / reset —
    // reset-password carries no email, so it gets the per-IP bucket
    // only), verification mail, and OAuth initiation. GETs (OAuth
    // callbacks, session reads) and verify-email are not limited.
    const path = r.nextUrl.pathname
    if (path.endsWith("/sign-in/email")) {
      const limited = await enforceAuthSignInRateLimit(r)
      if (limited) return limited
    } else if (path.endsWith("/sign-up/email")) {
      const limited = await enforceAuthSignUpRateLimit(r)
      if (limited) return limited
    } else if (
      path.endsWith("/forget-password") ||
      path.endsWith("/request-password-reset") ||
      path.endsWith("/reset-password")
    ) {
      const limited = await enforceAuthEmailRateLimit(r, "reset")
      if (limited) return limited
    } else if (path.endsWith("/send-verification-email")) {
      const limited = await enforceAuthEmailRateLimit(r, "verify")
      if (limited) return limited
    } else if (
      path.endsWith("/sign-in/social") ||
      path.endsWith("/sign-up/social")
    ) {
      const limited = await enforceAuthEmailRateLimit(r, "social")
      if (limited) return limited
    }
    return handlers.POST(r)
  })
