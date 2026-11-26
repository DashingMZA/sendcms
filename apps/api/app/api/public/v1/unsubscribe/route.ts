import { NextRequest } from "next/server"
import { verifyUnsubscribeToken } from "@sendcms/email"
import { unsubscribeRecipient } from "@sendcms/notifications"
import { handleApiError, methodNotAllowed } from "@sendcms/api-client"

// Public unsubscribe (EML-011) — no session. The signed token IS the
// proof (HMAC over email + form scope, keyed by BETTER_AUTH_SECRET),
// so the link works straight from the inbox with no login. GET only:
// a mail client prefetching the link must not unsubscribe anyone by
// accident — but the List-Unsubscribe header points here, and the
// one-click (RFC 8058) flow is a GET by design, so the token's
// single purpose (opt-out) is the whole action. An invalid token is
// 400; a valid one records the suppression + disables the matching
// notification settings, then answers a plain confirmation page.
// The address comes from a server-signed token, but it is still
// escaped before it lands in HTML.
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c
  )
}

function unsubscribeConfirmationPage(email: string, scope: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Unsubscribed — SendCMS</title></head>` +
    `<body style="font-family: sans-serif; max-width: 560px; margin: 48px auto; padding: 0 16px;">` +
    `<h1>You have been unsubscribed</h1>` +
    `<p><strong>${escapeHtml(email)}</strong> will no longer receive ${scope}.</p>` +
    `<p>If this was a mistake, re-enable notifications in the form settings.</p>` +
    `</body></html>`
  )
}

export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get("token")
    if (!token) {
      return new Response("Missing unsubscribe token.", { status: 400 })
    }
    const verified = verifyUnsubscribeToken(token)
    if (!verified) {
      return new Response("This unsubscribe link is invalid or expired.", {
        status: 400,
      })
    }
    await unsubscribeRecipient(verified)
    const scope =
      verified.formId === null
        ? "all SendCMS notification emails"
        : "notification emails for this form"
    return new Response(unsubscribeConfirmationPage(verified.email, scope), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
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
