import { listPublishedPlans } from "@sendcms/plans"
import { handleApiError, ok } from "@sendcms/api-client"

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
