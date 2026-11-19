import { NextResponse } from "next/server"

// The updates app has no middleware: its pages are public. This file
// exists so a proxy at the workspace root (if one is ever added) is not
// picked up as this app's proxy (Turbopack resolves the proxy file from
// the workspace root — see ADR 0004). The empty matcher means this proxy
// never runs.
export function proxy() {
  return NextResponse.next()
}

export const config = {
  matcher: [],
}
