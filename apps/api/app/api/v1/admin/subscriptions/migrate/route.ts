import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { updateSubscriptionAtProvider } from "@sendcms/billing"
import { executeMigration } from "@sendcms/plans"
import { ExecuteMigrationSchema } from "@sendcms/plans/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// BIL-089 (Wave 8): the migration updates the PROVIDER subscription
// where the provider supports a plan change (Stripe/PayPal/Polar);
// Freemius/Gumroad rows migrate SendCMS-only and the audit records
// exactly which users were provider-synced and which were not.
export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApi("MIGRATE_SUBSCRIPTIONS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const body = await req.json().catch(() => ({}))
    const parsed = ExecuteMigrationSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const result = await executeMigration(session, parsed.data, {
      updateAtProvider: updateSubscriptionAtProvider,
    })
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
