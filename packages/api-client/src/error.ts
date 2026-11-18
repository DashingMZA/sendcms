import { ApiError } from "@sendcms/shared"

export { ApiError }

import { NextResponse } from "next/server"
import { corsHeaders } from "./cors"

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
