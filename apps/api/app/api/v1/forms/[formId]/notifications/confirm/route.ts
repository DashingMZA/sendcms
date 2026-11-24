import { NextRequest, NextResponse } from "next/server"
import { confirmNotificationEmail } from "@sendcms/forms"
import { ApiError, handleApiError } from "@sendcms/api-client"

type Params = { params: Promise<{ formId: string }> }

// Public: the recipient clicking the confirmation link in their email is
// not signed in — the single-use token is the credential (EML-004).
// Success lands the recipient on the form's dashboard page.
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { formId } = await params
    const token = new URL(req.url).searchParams.get("token")
    if (!token) throw new ApiError("Missing confirmation token", 400)
    const confirmed = await confirmNotificationEmail(formId, token)
    const dashboard =
      process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3002"
    return NextResponse.redirect(
      `${dashboard}/dashboard/forms/${confirmed.formId}?recipientConfirmed=1`
    )
  } catch (err) {
    return handleApiError(err)
  }
}
