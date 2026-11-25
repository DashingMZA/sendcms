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
  // SRC-206: a raw Prisma error used to collapse into a generic 500.
  // Concurrent duplicates (a pre-check-then-create race) are a 409,
  // a missing row is a 404, a broken foreign key is a 400 — the
  // services' own messages already say this for the non-race path.
  // Duck-typed (name + code) on purpose — this package must not
  // depend on @prisma/client.
  const prismaStatus = prismaErrorStatus(err)
  if (prismaStatus !== null) {
    return NextResponse.json(
      { error: prismaStatus.message },
      { status: prismaStatus.status, headers: resolvedHeaders }
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

// Prisma's known-request errors: a unique-constraint violation
// (P2002), a missing record (P2025), a broken foreign-key reference
// (P2003). Only the code is trusted — never a message, which can
// carry table/column internals.
function prismaErrorStatus(
  err: unknown
): { status: number; message: string } | null {
  if (typeof err !== "object" || err === null) return null
  const candidate = err as { name?: unknown; code?: unknown }
  if (candidate.name !== "PrismaClientKnownRequestError") return null
  switch (candidate.code) {
    case "P2002":
      return {
        status: 409,
        message: "A record with these values already exists.",
      }
    case "P2025":
      return { status: 404, message: "Record not found." }
    case "P2003":
      return {
        status: 400,
        message: "The referenced record does not exist.",
      }
    default:
      return null
  }
}
