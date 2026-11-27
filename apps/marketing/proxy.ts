import { NextResponse, type NextRequest } from "next/server"
import { apiUrl } from "@/lib/app-links"
import {
  buildCsp,
  createCspNonce,
  cspHeaderName,
  CSP_REPORT_ONLY,
} from "@sendcms/security"

// The marketing app has no auth middleware: its pages are public.
// This file exists so a proxy at the workspace root (if one is ever
// added) is not picked up as this app's proxy (Turbopack resolves the
// proxy file from the workspace root — see ADR 0004).
//
// Since the Admin Control Plane Phase 9 CSP pass, this proxy DOES run:
// it attaches a per-request CSP nonce to every document response (the
// nonce lets Next.js's own inline scripts run under the policy — see
// `packages/security/src/csp.ts`). The matcher excludes static assets
// (`/_next/static`, `/_next/image`, `favicon.ico`, and any path with a
// file extension): those are not documents. (The static HTML demo page
// `/demo/contact-us.html` used to be excluded here for its inline
// `<style>`/`<script>`; it was deleted in Wave 11 (PRF-035) and 301s
// to the Next route, so the exclusion no longer has a demo to cover.)
//
// The CSP builder lives in `@sendcms/security`, but this proxy imports
// it by relative path: the package barrel (`src/index.ts`) is owned by
// the in-flight rate-limit work and must not be touched by this pass.
// Move the import to the barrel (`@sendcms/security`) at integration.
export function proxy(req: NextRequest) {
  const nonce = createCspNonce()
  // The demo page loads the SDK script from the api origin and its
  // REST tab fetches the submit API cross-origin — the policy allows
  // that origin for `connect-src` (there is no nonce mechanism for
  // `fetch`). See `packages/security/src/csp.ts`. Violations report
  // to the api app's report route (Phase 16, SRC-318).
  const apiOrigin = apiUrl()
  const policy = buildCsp(nonce, {
    apiOrigin,
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
