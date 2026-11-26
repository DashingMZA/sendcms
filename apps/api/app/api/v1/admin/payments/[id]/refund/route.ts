import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { refundPayment } from "@sendcms/billing"
import { RefundPaymentSchema } from "@sendcms/billing/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Record an admin refund (Seven Admin Pages, Phase B, plan §3.5,
// Q11). MANAGE_BILLING + step-up re-auth, enforced in the service:
// one password entry authorizes exactly one refund. Wires the
// existing applyRefund — local-only bookkeeping, no provider call;
// the refund itself must already have been issued at the provider.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireAdminApi("MANAGE_BILLING")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = RefundPaymentSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const result = await refundPayment(session, id, parsed.data)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
