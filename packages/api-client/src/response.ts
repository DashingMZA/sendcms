import { NextResponse } from "next/server"

export const ok = <T>(data: T, status = 200) =>
  NextResponse.json(data, { status })

export const created = <T>(data: T) => NextResponse.json(data, { status: 201 })

export const noContent = () => new NextResponse(null, { status: 204 })

// SDK-031: Next.js answers a wrong-method request on a route with an
// empty 405 and no `Allow` header. Public routes export this for every
// method they do not implement, so the JSON error contract holds for
// 405s too.
export const methodNotAllowed = (allowed: readonly string[]) =>
  NextResponse.json(
    { error: "Method not allowed" },
    { status: 405, headers: { Allow: allowed.join(", ") } }
  )
