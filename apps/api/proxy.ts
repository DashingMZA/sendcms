import { NextResponse } from "next/server"

// The API app has no middleware: its routes are public (Origin
// allowlist, enforced in the handlers) or session-gated inside the
// handlers. This file exists so the workspace-root proxy.ts — the
// dashboard's middleware, which lives at the repo root until Phase 7
// moves it to apps/dashboard — is not picked up as this app's proxy
// (Turbopack resolves the proxy file from the workspace root). The
// empty matcher means this proxy never runs.
export function proxy() {
  return NextResponse.next()
}

export const config = {
  matcher: [],
}
