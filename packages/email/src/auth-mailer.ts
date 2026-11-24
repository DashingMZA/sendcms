import { render } from "@react-email/render"
import { sendPlatformEmail } from "./provider"
import { VerifyEmail } from "./templates/verify-email"
import { ResetPasswordEmail } from "./templates/reset-password"

// Auth mail uses its own neutral branding (not the comment-product values
// in config/config.json — those are rebranded in Phase 9).
const ACCENT_COLOR = "#0891b2"
const FOOTER_TEXT = "You're receiving this because you have a SendCMS account."

// EML-002: reset/verification tokens are bearer-equivalent — the dev log
// is a shared, persistent file, so the token must never land in it by
// default. Only an explicit opt-in prints the full link (local journey
// debugging); anything else logs the redacted shape. (Read at call time
// so tests can stub the env var per case.)
function logFullEmailLink(): boolean {
  return process.env.SENDCMS_DEV_LOG_EMAIL_TOKENS === "1"
}

/** Redacts the bearer token out of an auth-mail URL, keeping the rest of
    the link shape so the dev log still shows where the link points:
    `/reset-password/<token>` → `/reset-password/<redacted>`,
    `?token=<token>` → `?token=<redacted>`. A URL in no known shape is
    reduced to its origin — never logged whole, since an unknown shape
    may still carry a token. */
export function redactAuthEmailUrl(url: string): string {
  let redacted = url.replace(/(\/reset-password\/)[^/?#]+/, "$1<redacted>")
  redacted = redacted.replace(/([?&]token=)[^&#]*/, "$1<redacted>")
  if (redacted !== url) return redacted
  try {
    return `${new URL(url).origin}/<redacted>`
  } catch {
    return "<redacted>"
  }
}

type AuthEmailUser = {
  name: string
  email: string
}

async function deliverOrLog({
  kind,
  to,
  subject,
  html,
  url,
}: {
  kind: "verification" | "password reset"
  to: string
  subject: string
  html: string
  url: string
}): Promise<void> {
  // Phase 8: one shared provider (Resend → platform SMTP). Without
  // any provider the contract is unchanged: dev logs the link,
  // production fails loudly.
  try {
    await sendPlatformEmail({ to, subject, html })
    return
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      // Loud failure: without a mailer, verification/reset can never complete.
      throw new Error(
        `Cannot send ${kind} email: no email provider is configured ` +
          `(set RESEND_API_KEY or SMTP_HOST/SMTP_USER/SMTP_PASS). ` +
          `Cause: ${err instanceof Error ? err.message : "unknown"}`
      )
    }
    // Dev fallback: the link is only visible in the server log, never to the
    // browser, so the register → verify → login journey stays testable
    // without an SMTP server. EML-002: the token itself is redacted —
    // only the link shape is logged, unless the operator explicitly
    // opted into full links (SENDCMS_DEV_LOG_EMAIL_TOKENS=1).
    console.log(
      `[auth-email] No email provider — ${kind} link for ${to}: ${
        logFullEmailLink() ? url : redactAuthEmailUrl(url)
      }`
    )
  }
}

/** Better Auth `emailVerification.sendVerificationEmail` callback. */
export async function sendVerificationEmail({
  user,
  url,
}: {
  user: AuthEmailUser
  url: string
}): Promise<void> {
  const html = await render(
    VerifyEmail({
      userName: user.name,
      url,
      accentColor: ACCENT_COLOR,
      footerText: FOOTER_TEXT,
    })
  )
  await deliverOrLog({
    kind: "verification",
    to: user.email,
    subject: "Verify your SendCMS email address",
    html,
    url,
  })
}

/** Better Auth `emailAndPassword.sendResetPassword` callback. */
export async function sendPasswordResetEmail({
  user,
  url,
}: {
  user: AuthEmailUser
  url: string
}): Promise<void> {
  const html = await render(
    ResetPasswordEmail({
      userName: user.name,
      url,
      accentColor: ACCENT_COLOR,
      footerText: FOOTER_TEXT,
    })
  )
  await deliverOrLog({
    kind: "password reset",
    to: user.email,
    subject: "Reset your SendCMS password",
    html,
    url,
  })
}
