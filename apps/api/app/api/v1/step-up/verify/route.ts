import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"
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
    const body = (await req.json().catch(() => ({}))) as unknown
    const password =
      typeof body === "object" &&
      body !== null &&
      "password" in body &&
      typeof (body as { password: unknown }).password === "string"
        ? (body as { password: string }).password
        : undefined
    const action =
      typeof body === "object" &&
      body !== null &&
      "action" in body &&
      typeof (body as { action: unknown }).action === "string"
        ? (body as { action: string }).action
        : undefined
    if (password === undefined) {
      return NextResponse.json(
        { error: "Password is required." },
        { status: 422 }
      )
    }
    if (!isStepUpAction(action)) {
      return NextResponse.json(
        { error: "A valid action is required." },
        { status: 422 }
      )
    }
    const result = await verifyStepUp(session, password, { action })
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
