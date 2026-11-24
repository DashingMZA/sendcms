import { NextRequest, NextResponse } from "next/server"
import { auth, betterAuth } from "@/lib/auth"
import {
  enforceAuthEmailRateLimit,
  enforceAuthSignInRateLimit,
  enforceAuthSignUpRateLimit,
} from "@/lib/rate-limit"
import {
  getEffectiveOrigin,
  handleApiError,
  normalizeOrigin,
} from "@sendcms/api-client"
import { toNextJsHandler } from "@sendcms/auth"
import {
  consumeStepUpVerification,
  findStepUpVerification,
  type StepUpAction,
} from "@sendcms/security"

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

// SRC-122: a throw inside Better Auth (or the gating below) must not
// surface as an unhandled error with no CORS headers — the
// cross-origin dashboard client would see an opaque network failure
// instead of a readable error. Errors return a CORS-headed 500 via
// handleApiError.
async function withCorsSafe(
  req: NextRequest,
  handler: (req: NextRequest) => Promise<Response>
): Promise<Response> {
  try {
    return await withCors(req, handler)
  } catch (err) {
    const origin = trustedOrigin(req)
    return handleApiError(
      err,
      undefined,
      origin ? authCorsHeaders(origin) : undefined
    )
  }
}

// SEC-012: the session token is delivered via the HttpOnly cookie
// only. Sign-in, change-password, reset-password and verify-email all
// mint a session, and Better Auth returns its token in the JSON body
// as well — strip it. The browser client reads the session from the
// cookie, never from the body, and no dashboard/admin code reads
// `data.token`, so nothing breaks.
const TOKEN_BODY_PATH_SUFFIXES = [
  "/sign-in/email",
  "/change-password",
  "/reset-password",
  "/verify-email",
]

async function stripSessionToken(
  response: Response,
  path: string
): Promise<Response> {
  if (!TOKEN_BODY_PATH_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
    return response
  }
  if (
    !(response.headers.get("content-type") ?? "").includes("application/json")
  ) {
    return response
  }
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as unknown
  if (typeof body !== "object" || body === null) return response
  const data = body as Record<string, unknown>
  let stripped = false
  if ("token" in data) {
    delete data.token
    stripped = true
  }
  const session = data.session
  if (
    typeof session === "object" &&
    session !== null &&
    "token" in (session as Record<string, unknown>)
  ) {
    delete (session as Record<string, unknown>).token
    stripped = true
  }
  if (!stripped) return response
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(JSON.stringify(data), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

// SEC-007: sensitive profile actions require a server-enforced
// step-up proof — a StepUpVerification row bound to the action,
// minted by the customer verify endpoint from a password re-entry.
// The proof is checked BEFORE Better Auth runs and consumed only when
// the action succeeds, so a failed change (wrong current password)
// does not burn the proof. No 2FA plugin or UI ships yet; the
// /two-factor/* change paths are gated the same way so the
// enforcement is already in place when the plugin lands (the
// verify-totp sign-in step is deliberately NOT gated — it is part of
// signing in, not a change).
const SENSITIVE_ACTION_BY_PATH_SUFFIX: Record<string, StepUpAction> = {
  "/change-password": "change-password",
  "/change-email": "change-email",
  "/two-factor/enable": "2fa-enable",
  "/two-factor/disable": "2fa-disable",
}

function sensitiveActionForPath(path: string): StepUpAction | null {
  for (const [suffix, action] of Object.entries(
    SENSITIVE_ACTION_BY_PATH_SUFFIX
  )) {
    if (path.endsWith(suffix)) return action
  }
  return null
}

export const GET = (req: NextRequest) => withCorsSafe(req, handlers.GET)
export const POST = (req: NextRequest) =>
  withCorsSafe(req, async (r) => {
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
    // Step-up gate for the sensitive actions (SEC-007). Without a
    // session Better Auth itself 401s, so the proof check — which
    // needs a user id — is skipped then; the action still cannot run
    // unauthenticated.
    let proofId: string | null = null
    const sensitiveAction = sensitiveActionForPath(path)
    if (sensitiveAction) {
      const session = await auth()
      if (session?.user?.id) {
        const proof = await findStepUpVerification(
          session.user.id,
          sensitiveAction
        )
        if (!proof) {
          return NextResponse.json(
            {
              error:
                "Step-up verification required. Re-enter your password to continue.",
            },
            { status: 403 }
          )
        }
        proofId = proof.id
      }
    }
    const response = await handlers.POST(r)
    // Single-use: spend the proof only when the action succeeded.
    if (proofId && response.ok) {
      await consumeStepUpVerification(proofId)
    }
    return stripSessionToken(response, path)
  })
