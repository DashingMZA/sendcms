// Shared validation-error handling (SRC-108): the flatten → join →
// 422 block was copy-pasted into 68 route files. Routes call these
// helpers instead; the message format is pinned by
// tests/validation-helper.test.ts.
//
// The error parameter is typed structurally on purpose: this package
// does not depend on zod, and every ZodError satisfies the shape.

import { NextResponse } from "next/server"

/** The ZodError shape these helpers need: `flatten()` only. */
export type ValidationErrorLike = {
  flatten: () => {
    formErrors: string[]
    fieldErrors: Record<string, string[] | undefined>
  }
}

/** `"a; b"` from a ZodError, or `"Validation failed"` when it is empty. */
export function validationErrorMessage(error: ValidationErrorLike): string {
  const flat = error.flatten()
  const messages = [
    ...flat.formErrors,
    ...Object.values(flat.fieldErrors).flat(),
  ].filter(Boolean)
  return messages.join("; ") || "Validation failed"
}

/** The standard 422 validation response: `{ error }` + status 422. */
export function validationErrorResponse(
  error: ValidationErrorLike
): NextResponse {
  return NextResponse.json(
    { error: validationErrorMessage(error) },
    { status: 422 }
  )
}

/** A 422 `{ error: "Invalid <key> date" }` when a date-valued query
    param is present but unparseable, else null. Used for the `from` /
    `to` list filters (SRC-231) and the usage `period` (SRC-119): the
    service builders silently dropped bad dates, so the route rejects
    them before the service ever runs. Callers pass only the date
    fields, e.g. `{ from: parsed.data.from, to: parsed.data.to }`. */
export function invalidDateFilterResponse(
  values: Readonly<Record<string, string | undefined>>,
  keys: readonly string[] = ["from", "to"]
): NextResponse | null {
  for (const key of keys) {
    const value = values[key]
    if (value !== undefined && Number.isNaN(new Date(value).getTime())) {
      return NextResponse.json(
        { error: `Invalid ${key} date` },
        { status: 422 }
      )
    }
  }
  return null
}
