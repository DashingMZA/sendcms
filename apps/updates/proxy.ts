import { NextResponse, type NextRequest } from "next/server"
import {
  buildCsp,
  createCspNonce,
  cspHeaderName,
  CSP_REPORT_ONLY,
} from "@sendcms/security"

// The updates app has no auth middleware: its pages are public. This
// file exists so a proxy at the workspace root (if one is ever added)
// is not picked up as this app's proxy (Turbopack resolves the proxy
// file from the workspace root — see ADR 0004).
//
// Since the Admin Control Plane Phase 9 CSP pass, this proxy DOES run:
// it attaches a per-request CSP nonce to every document response (the
// nonce lets Next.js's own inline scripts run under the policy — see
// `packages/security/src/csp.ts`). The matcher excludes static assets
// (`/_next/static`, `/_next/image`, `favicon.ico`, and any path with a
// file extension), which are not documents.
//
// The CSP builder lives in `@sendcms/security`, but this proxy imports
// it by relative path: the package barrel (`src/index.ts`) is owned by
// the in-flight rate-limit work and must not be touched by this pass.
// Move the import to the barrel (`@sendcms/security`) at integration.
export function proxy(req: NextRequest) {
  const nonce = createCspNonce()
  // Violations report to the api app's report route (Phase 16,
  // SRC-318) so enforcing-mode breakage is logged, not silently
  // dropped. The updates app makes no cross-origin browser fetches,
  // so it passes no `connect-src` origin — only the report endpoint.
  const apiOrigin = (
    process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
  ).replace(/\/$/, "")
  const policy = buildCsp(nonce, {
    reportUri: `${apiOrigin}/api/csp-report`,
  })
  const headerName = cspHeaderName(CSP_REPORT_ONLY)

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
