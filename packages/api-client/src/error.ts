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
  // ADM-001: Better Auth throws its own `APIError` (a better-call
  // error with a numeric `statusCode` and a `body: { message, code }`)
  // — e.g. EMAIL_MISMATCH (400) from the verification endpoint.
  // This used to collapse those into a generic 500, so the client
  // could never tell a bad request from a server failure. Map them
  // to their real status/message. The duck-type is narrow (name +
  // numeric statusCode + string body.message) so an unrelated error
  // can never be mistaken for one.
  if (isBetterAuthApiError(err)) {
    return NextResponse.json(
      { error: err.body.message },
      { status: err.statusCode, headers: resolvedHeaders }
    )
  }
  logger.error("unhandled API error", { error: err })
  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500, headers: resolvedHeaders }
  )
}

// The auth library's error shape (better-call `APIError`): a named
// error with a numeric HTTP status and a `{ message, code }` body.
// Checked structurally on purpose — the api-client package must not
// depend on better-auth.
type BetterAuthApiError = {
  name: "APIError"
  statusCode: number
  body: { message: string; code?: string }
}

function isBetterAuthApiError(err: unknown): err is BetterAuthApiError {
  if (typeof err !== "object" || err === null) return false
  const candidate = err as {
    name?: unknown
    statusCode?: unknown
    body?: unknown
  }
  if (
    candidate.name !== "APIError" ||
    typeof candidate.statusCode !== "number"
  ) {
    return false
  }
  const body = candidate.body as { message?: unknown } | null | undefined
  return typeof body?.message === "string"
}
