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
// file extension): those are not documents, and the static HTML demo
// page (`/demo/contact-us.html`) has inline `<style>`/`<script>` no
// nonce can be injected into, so it must not receive a CSP header.
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
  // `fetch`). See `packages/security/src/csp.ts`.
  const policy = buildCsp(nonce, { apiOrigin: apiUrl() })
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
