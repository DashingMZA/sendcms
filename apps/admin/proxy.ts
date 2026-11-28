import { NextResponse, type NextRequest } from "next/server"
import { betterAuth } from "@/lib/auth"
import {
  PLATFORM_ROUTE_CAPABILITY,
  adminCan,
  type PlatformRole,
} from "@sendcms/permissions"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import {
  buildCsp,
  createCspNonce,
  cspHeaderName,
  CSP_REPORT_ONLY,
} from "@sendcms/security/csp"

/**
 * Route protection for the admin app (Better Auth, database sessions).
 * - No session → the dashboard sign-in page, with a callbackURL back
 *   to the admin page that was requested. The admin app has NO sign-up
 *   page — admin accounts are owner-created (role assignment lands in
 *   Phase 3).
 * - A suspended/disabled user → the dashboard sign-in page too (their
 *   session is useless: the auth() helper also returns null for them).
 * - A signed-in user without the admin capability is sent to
 *   /admin/unauthorized. That page is explicitly allowed through here
 *   (it is the denial page itself) — without the exemption the proxy
 *   would redirect it to itself in a loop.
 * - Staff roles (Phase 3): the session carries `adminRole`, and the
 *   check passes it to `adminCan`. PLATFORM_OWNER keeps every
 *   capability; a plain customer (no adminRole) gets none.
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
  // unauthenticated path as well. The matcher also covers the landing
  // root and unmatched (404) paths (Phase 16, LVE-002) — those pass
  // through below without a session lookup.
  const nonce = createCspNonce()
  // The admin sidebar's sign-out posts cross-origin to the api app
  // (the Better Auth handler lives there), and there is no nonce
  // mechanism for `fetch`. So the policy allows that origin for
  // `connect-src`; without it, `default-src 'self'` blocks the
  // request and sign-out silently fails — same cause as the
  // dashboard's social buttons (found live 2026-11-23).
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

  // Landing root + unmatched (404) paths (Phase 16, LVE-002): public,
  // no session needed — attach the CSP and pass through so the page
  // (or the not-found page) renders. Only /admin/* routes go through
  // the session lookup below.
  if (
    req.nextUrl.pathname === "/" ||
    !req.nextUrl.pathname.startsWith("/admin")
  ) {
    return withCsp(NextResponse.next({ request: { headers: requestHeaders } }))
  }

  const result = await betterAuth.api.getSession({
    headers: req.headers,
  })
  if (!result) {
    return withCsp(
      NextResponse.redirect(
        dashboardSignInURL(`${adminBaseURL()}${req.nextUrl.pathname}`)
      )
    )
  }

  // Suspension enforcement (Phase 3): a non-ACTIVE account cannot use
  // the admin app at all.
  if ((result.user.status ?? "ACTIVE") !== "ACTIVE") {
    return withCsp(
      NextResponse.redirect(
        dashboardSignInURL(`${adminBaseURL()}${req.nextUrl.pathname}`)
      )
    )
  }

  const path = req.nextUrl.pathname
  // The denial page itself: signed-in, but no capability needed to see it.
  if (path === "/admin/unauthorized")
    return withCsp(NextResponse.next({ request: { headers: requestHeaders } }))

  // Longest matching prefix wins (Phase 16, Wave 2 — SEC-102): the
  // map holds both "/admin" and "/admin/ai/providers", and a plain
  // first-match would always stop at "/admin".
  const matched = Object.keys(PLATFORM_ROUTE_CAPABILITY)
    .filter((route) => path === route || path.startsWith(route + "/"))
    .sort((a, b) => b.length - a.length)[0]
  if (matched) {
    const role =
      result.user.platformRole === "PLATFORM_OWNER"
        ? "PLATFORM_OWNER"
        : ((result.user.adminRole ?? "PLATFORM_USER") as
            PlatformRole | "SUPER_ADMIN" | "MANAGER" | "SUPPORT")
    if (!adminCan(role, PLATFORM_ROUTE_CAPABILITY[matched])) {
      return withCsp(
        NextResponse.redirect(new URL("/admin/unauthorized", req.url))
      )
    }
  }
  return withCsp(NextResponse.next({ request: { headers: requestHeaders } }))
}

export const config = {
  matcher: [
    "/",
    "/admin/:path*",
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
