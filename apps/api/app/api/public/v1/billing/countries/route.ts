import { listPublicCountries } from "@sendcms/billing"
import { handleApiError, methodNotAllowed, ok } from "@sendcms/api-client"

// Public countries: the full country list for the checkout page's
// country select. No auth — country names are public data.
export async function GET() {
  try {
    return ok(await listPublicCountries())
  } catch (err) {
    return handleApiError(err)
  }
}

// SDK-031: wrong-method requests get a JSON 405 with an Allow
// header, not Next.js's empty 405.
export const POST = () => methodNotAllowed(["GET"])
export const PUT = () => methodNotAllowed(["GET"])
export const PATCH = () => methodNotAllowed(["GET"])
export const DELETE = () => methodNotAllowed(["GET"])
export const OPTIONS = () => methodNotAllowed(["GET"])
