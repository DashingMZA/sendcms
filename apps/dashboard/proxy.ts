import { NextResponse, type NextRequest } from "next/server"
import { betterAuth } from "@/lib/auth"
import {
  PLATFORM_ROUTE_CAPABILITY,
  platformCan,
  type PlatformRole,
} from "@sendcms/permissions"
import {
  buildCsp,
  createCspNonce,
  cspHeaderName,
  CSP_REPORT_ONLY,
} from "@sendcms/security"

/**
 * Route protection (Better Auth, database sessions).
 * - No session → /sign-in.
 * - A suspended/disabled user → /sign-in (their session is useless:
 *   the auth() helper also returns null for them).
 * - Logged-in users without the platform capability for a route are sent
 *   to /dashboard (same behaviour as the old Auth.js `authorized` check).
 *
 * Session lookup hits Prisma, so this runs on the Node.js runtime (the
 * Next 16 proxy default) — it is NOT edge-safe.
 */
export default async function proxy(req: NextRequest) {
  // CSP nonce (Admin Control Plane, Phase 9): a fresh nonce per
  // request, set on the request headers so Next.js applies it to its
  // own inline scripts, and on every response this proxy returns.
  // The header rides on the redirect responses too — browsers ignore
  // CSP on redirects, but it makes the header observable on the
  // unauthenticated path as well.
  const nonce = createCspNonce()
  // The browser auth client posts cross-origin to the api app (the
  // Better Auth handler lives there — sign-in, sign-up, and the
  // social OAuth flow all go through it), and there is no nonce
  // mechanism for `fetch`. So the policy allows that origin for
  // `connect-src`; without it, `default-src 'self'` blocks every
  // auth request and the social buttons silently do nothing (found
  // live 2026-11-23, the second enforcing-CSP breakage after the
  // sidebar overlap). The `/api/v1/*` data fetches stay same-origin
  // through the rewrite below and need no allowlist.
  const apiOrigin = (
    process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
  ).replace(/\/$/, "")
  const policy = buildCsp(nonce, { apiOrigin })
  const headerName = cspHeaderName(CSP_REPORT_ONLY)
  const withCsp = (response: NextResponse): NextResponse => {
    response.headers.set(headerName, policy)
    return response
  }
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set(headerName, policy)

  // Public auth pages (Admin Control Plane, Phase 9): they live
  // outside /dashboard but must still get the CSP header. They need
  // no session, so they pass straight through here, before the
  // session lookup — no redirect, no database hit.
  const AUTH_PAGES = [
    "/sign-in",
    "/sign-up",
    "/forgot-password",
    "/reset-password",
    "/verify-email",
  ]
  if (AUTH_PAGES.includes(req.nextUrl.pathname)) {
    return withCsp(NextResponse.next({ request: { headers: requestHeaders } }))
  }

  const result = await betterAuth.api.getSession({
    headers: req.headers,
  })
  if (!result) {
    const url = req.nextUrl.clone()
    url.pathname = "/sign-in"
    return withCsp(NextResponse.redirect(url))
  }

  // Suspension enforcement (Admin Control Plane, Phase 3).
  if ((result.user.status ?? "ACTIVE") !== "ACTIVE") {
    const url = req.nextUrl.clone()
    url.pathname = "/sign-in"
    return withCsp(NextResponse.redirect(url))
  }

  const path = req.nextUrl.pathname
  const matched = Object.keys(PLATFORM_ROUTE_CAPABILITY).find(
    (route) => path === route || path.startsWith(route + "/")
  )
  if (matched) {
    const role = (result.user.platformRole ?? "PLATFORM_USER") as PlatformRole
    if (!platformCan(role, PLATFORM_ROUTE_CAPABILITY[matched])) {
      return withCsp(NextResponse.redirect(new URL("/dashboard", req.url)))
    }
  }
  return withCsp(NextResponse.next({ request: { headers: requestHeaders } }))
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/sign-in",
    "/sign-up",
    "/forgot-password",
    "/reset-password",
    "/verify-email",
  ],
}
