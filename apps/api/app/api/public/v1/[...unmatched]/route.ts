import { NextResponse } from "next/server"

// SDK-031: an unknown path under /api/public/v1/ returns a JSON 404,
// not the Next.js HTML 404 page — the public API's error contract is
// JSON everywhere. Static routes still win over this catch-all, so it
// only answers paths no route defines (e.g. /api/public/v1/nope).
// No CORS headers: an unknown path is not an allowed origin's error.
function unknownPublicPath() {
  return NextResponse.json({ error: "Not found" }, { status: 404 })
}

export const GET = unknownPublicPath
export const POST = unknownPublicPath
export const PUT = unknownPublicPath
export const PATCH = unknownPublicPath
export const DELETE = unknownPublicPath
export const OPTIONS = unknownPublicPath
