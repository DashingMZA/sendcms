import { ApiError } from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"

export { ApiError }

import { NextResponse } from "next/server"
import { corsHeaders } from "./cors"

const logger = createLogger("api")

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
  logger.error("unhandled API error", { error: err })
  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500, headers: resolvedHeaders }
  )
}
