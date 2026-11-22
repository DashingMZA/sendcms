import { listPublicCountries } from "@sendcms/billing"
import { handleApiError, ok } from "@sendcms/api-client"

// Public countries: the full country list for the checkout page's
// country select. No auth — country names are public data.
export async function GET() {
  try {
    return ok(await listPublicCountries())
  } catch (err) {
    return handleApiError(err)
  }
}
