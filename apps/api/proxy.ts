import { NextResponse, type NextRequest } from "next/server"
import { getEffectiveOrigin, normalizeOrigin } from "@sendcms/api-client"
import {
  buildCsp,
  createCspNonce,
  cspHeaderName,
  CSP_REPORT_ONLY,
} from "@sendcms/security"

// The api app serves route handlers + a branded 404 page, and its
// proxy used to be a no-op with an empty matcher — so no api response
// ever carried a Content-Security-Policy (Phase 16, SEC-303). Since
// this pass it attaches the shared enforcing policy to every
// extensionless path (API responses included — a CSP header on a JSON
// response is harmless, and the 404 page is HTML). Static assets
// (the SDK bundle `/forms/v1.js`, `/_next/static`, any path with a
// file extension) are excluded: they are not documents.
//
// The policy is the shared shape, adapted to the api app: no
// `connect-src` (the api app makes no cross-origin browser fetches),
// the report endpoint is the same-origin path `/api/csp-report`, and
// `allowInlineStyles` is set — the branded 404 page renders an
// authored `<style>` block that Next does not nonce, so the standard
// nonce-gated `style-src` would strip its styling. `script-src`
// stays nonce-gated and strict.
//
// This file exists so the dashboard app's proxy
// (`apps/dashboard/proxy.ts`) is not picked up as this app's proxy
// (Turbopack resolves the proxy file from the workspace root).
// Origin allowlist for state-changing /api/v1/* requests (SEC-202):
// SameSite=Lax on the session cookie was the only CSRF defence, and a
// cross-origin POST carrying a valid cookie succeeded. The origins
// that may call the cookie-authenticated v1 API from a browser are
// the api app itself plus the dashboard / admin apps (the same set
// Better Auth trusts, plus the public app URLs). A request with no
// Origin/Referer at all (curl, server-to-server, non-browser clients)
// is allowed — only a present, mismatched origin is rejected.
function allowedV1Origins(): Set<string> {
  const raw = [
    process.env.BETTER_AUTH_URL,
    ...(process.env.TRUSTED_ORIGINS ?? "").split(","),
    process.env.NEXT_PUBLIC_DASHBOARD_URL,
    process.env.NEXT_PUBLIC_ADMIN_URL,
    process.env.NEXT_PUBLIC_API_URL,
  ]
  return new Set(
    raw
      .filter((o): o is string => typeof o === "string" && o.trim() !== "")
      .map((o) => normalizeOrigin(o))
  )
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

export function proxy(req: NextRequest) {
  if (
    req.nextUrl.pathname.startsWith("/api/v1/") &&
    STATE_CHANGING_METHODS.has(req.method)
  ) {
    const origin = getEffectiveOrigin(req)
    if (origin && !allowedV1Origins().has(normalizeOrigin(origin))) {
      return NextResponse.json(
        { error: "Forbidden: origin not allowed." },
        { status: 403 }
      )
    }
  }
  const nonce = createCspNonce()
  const policy = buildCsp(nonce, {
    reportUri: "/api/csp-report",
    allowInlineStyles: true,
  })
  const headerName = cspHeaderName(CSP_REPORT_ONLY)

  // PRF-005 (Phase 16, Wave 11): reject non-POST methods on the public
  // submit endpoint HERE, in the proxy, so the 405 is returned without
  // a route-handler (serverless function) invocation — the GET 405
  // used to be the slowest endpoint measured (median TTFB 1.88 s for
  // a 0-byte response) because it paid the full invocation cost. Only
  // POST (the submission) and OPTIONS (the CORS preflight, answered
  // by the route) pass through. The route still exports its own 405s
  // (SDK-031) as a backstop for any request that reaches it, with the
  // same `Allow: POST, OPTIONS` value — keep the two in sync. The
  // 405 still carries the CSP header, like every other api response
  // (SEC-303).
  if (
    req.nextUrl.pathname === "/api/public/v1/submit" &&
    req.method !== "POST" &&
    req.method !== "OPTIONS"
  ) {
    return NextResponse.json(
      { error: "Method not allowed" },
      {
        status: 405,
        headers: { Allow: "POST, OPTIONS", [headerName]: policy },
      }
    )
  }

  const requestHeaders = new Headers(req.headers)
  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set(headerName, policy)

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  })
  response.headers.set(headerName, policy)
  return response
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)",
    },
  ],
}
