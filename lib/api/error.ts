import { NextResponse } from "next/server"
import { corsHeaders } from "@/lib/cors"

export class ApiError extends Error {
  // Set by services that know whether the request origin passed the
  // allowlist (public API) — the route only echoes CORS headers for
  // allowed origins, so a rejected origin cannot read the response.
  originAllowed?: boolean

  constructor(
    public readonly message: string,
    public readonly status: number = 400
  ) {
    super(message)
  }
}

export function handleApiError(
  err: unknown,
  origin?: string,
  headers?: Record<string, string>
): NextResponse {
  const resolvedHeaders = headers ?? (origin ? corsHeaders(origin) : undefined)
  if (err instanceof ApiError) {
    return NextResponse.json(
      { error: err.message },
      { status: err.status, headers: resolvedHeaders }
    )
  }
  console.error(err)
  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500, headers: resolvedHeaders }
  )
}
