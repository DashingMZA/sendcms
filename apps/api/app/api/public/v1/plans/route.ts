import { listPublishedPlans } from "@sendcms/plans"
import { handleApiError, methodNotAllowed, ok } from "@sendcms/api-client"

// Public plans: every published, non-private plan with its current
// published version (price + limits). No auth — the marketing
// pricing page and anyone comparing plans read this.
export async function GET() {
  try {
    return ok(await listPublishedPlans())
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
