import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import {
  ApiError,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"
import { StepUpVerifySchema } from "@sendcms/admin-users/validators"
import { isStepUpAction, verifyStepUp } from "@sendcms/security"

// Customer step-up verification (Phase 16, Wave 2: SEC-007): the
// user re-enters their password to mint a proof for ONE sensitive
// action (change-password, change-email, 2FA changes). The auth
// passthrough route enforces the proof before the action runs and
// consumes it when the action succeeds — the proof is single-use and
// bound to the action, so it cannot unlock anything else. The
// password is checked against the credential Account row, counts
// against the 5/hour attempt cap, and the response carries only the
// expiry — never the password or the hash.
export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const body = await req.json().catch(() => ({}))
    // SRC-104: the password is validated with the shared Zod schema
    // (capped at 128 chars) instead of the hand-rolled typeof check
    // — the same defect the admin step-up route had.
    const parsed = StepUpVerifySchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const action = stepUpAction(body)
    const result = await verifyStepUp(session, parsed.data.password, {
      action,
    })
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}

// Extracts the step-up action from the body, or throws the 422 the
// route used to return inline.
function stepUpAction(body: unknown): string {
  const action =
    typeof body === "object" &&
    body !== null &&
    "action" in body &&
    typeof (body as { action: unknown }).action === "string"
      ? (body as { action: string }).action
      : undefined
  if (!isStepUpAction(action)) {
    throw new ApiError("A valid action is required.", 422)
  }
  return action
}
