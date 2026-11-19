import { render } from "@react-email/render"
import { sendPlatformEmail } from "./provider"
import { VerifyEmail } from "./templates/verify-email"
import { ResetPasswordEmail } from "./templates/reset-password"

// Auth mail uses its own neutral branding (not the comment-product values
// in config/config.json — those are rebranded in Phase 9).
const ACCENT_COLOR = "#0891b2"
const FOOTER_TEXT = "You're receiving this because you have a SendCMS account."

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
    // without an SMTP server.
    console.log(
      `[auth-email] No email provider — ${kind} link for ${to}: ${url}`
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
