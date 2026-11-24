import { NextResponse, type NextRequest } from "next/server"
import { betterAuth } from "@/lib/auth"
import { createLogger } from "@sendcms/observability"
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
  const logger = createLogger("dashboard-proxy")
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
  // CSP violation reports (Phase 16, SRC-318): the policy's
  // `report-uri` points at the api app's report route so enforcing
  // violations are logged instead of silently dropped.
  const policy = buildCsp(nonce, {
    apiOrigin,
    reportUri: `${apiOrigin}/api/csp-report`,
  })
  const headerName = cspHeaderName(CSP_REPORT_ONLY)
  const withCsp = (response: NextResponse): NextResponse => {
    response.headers.set(headerName, policy)
    return response
  }
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set(headerName, policy)

  // The deep link the user asked for, preserved through sign-in
  // (Phase 16, Wave 2 — SRC-116): the sign-in page honours
  // `callbackURL` and lands the user back on the original path
  // afterwards, instead of always dropping them on /dashboard.
  const redirectToSignIn = (): NextResponse => {
    const url = new URL("/sign-in", req.url)
    url.searchParams.set(
      "callbackURL",
      req.nextUrl.pathname + req.nextUrl.search
    )
    return withCsp(NextResponse.redirect(url))
  }

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

  // Landing root + unmatched (404) paths (Phase 16, LVE-002): public,
  // no session needed — attach the CSP and pass through so the page
  // (or the not-found page) renders. Only /dashboard/* routes go
  // through the session lookup below.
  if (
    req.nextUrl.pathname === "/" ||
    !req.nextUrl.pathname.startsWith("/dashboard")
  ) {
    return withCsp(NextResponse.next({ request: { headers: requestHeaders } }))
  }

  // SEC-006: a failing session lookup (the database is unreachable)
  // must redirect to sign-in, never throw an unhandled 500 from the
  // proxy. The failure is logged server-side; the sign-in redirect
  // keeps the deep link, so the user lands back here once the
  // database (and sign-in) works again.
  let result
  try {
    result = await betterAuth.api.getSession({
      headers: req.headers,
    })
  } catch (err) {
    logger.error("dashboard proxy session lookup failed", { error: err })
    return redirectToSignIn()
  }
  if (!result) {
    return redirectToSignIn()
  }

  // Suspension enforcement (Admin Control Plane, Phase 3).
  if ((result.user.status ?? "ACTIVE") !== "ACTIVE") {
    return redirectToSignIn()
  }

  const path = req.nextUrl.pathname
  // Longest matching prefix wins (Phase 16, Wave 2 — SEC-102): the
  // map holds nested entries, and a plain first-match would always
  // stop at the shortest one.
  const matched = Object.keys(PLATFORM_ROUTE_CAPABILITY)
    .filter((route) => path === route || path.startsWith(route + "/"))
    .sort((a, b) => b.length - a.length)[0]
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
    "/",
    "/dashboard/:path*",
    "/sign-in",
    "/sign-up",
    "/forgot-password",
    "/reset-password",
    "/verify-email",
    // Catch-all for extensionless paths (Phase 16, LVE-002): the
    // landing root and the not-found responses. Static assets
    // (`/_next/static`, `/_next/image`, `favicon.ico`, any path with
    // a file extension) and the `/api/v1/*` rewrites (proxied to the
    // api app — they must not hit the session gate here) are excluded.
    {
      source: "/((?!_next/static|_next/image|favicon.ico|api/|.*\\..*).*)",
    },
  ],
}
