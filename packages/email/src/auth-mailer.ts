import { render } from "@react-email/render"
import { resolveEmailProvider, sendPlatformEmail } from "./provider"
import { AccountApproved } from "./templates/account-approved"
import { VerifyEmail } from "./templates/verify-email"
import { ResetPasswordEmail } from "./templates/reset-password"
import { getEmailTranslator } from "./email-i18n"

// Auth mail uses its own neutral branding (not the comment-product values
// in config/config.json — those are rebranded in Phase 9).
const ACCENT_COLOR = "#0891b2"

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

export type AuthEmailKind = "verification" | "password reset"

/** What a failed auth send hands to the durable-record callback
    (EML-009): everything the outbox needs to retry it later. */
export type FailedAuthEmailRecord = {
  kind: AuthEmailKind
  to: string
  subject: string
  html: string
  url: string
}

export type AuthMailerOpts = {
  /** EML-009: called when a configured provider fails to send, so
      the failure leaves a durable, retryable record (the outbox)
      instead of vanishing. Best-effort — a callback failure is
      logged, never swallowed, and the original send error still
      propagates. */
  onSendFailure?: (record: FailedAuthEmailRecord) => Promise<void>
}

async function deliverOrLog({
  kind,
  to,
  subject,
  html,
  url,
  onSendFailure,
}: {
  kind: AuthEmailKind
  to: string
  subject: string
  html: string
  url: string
  onSendFailure?: AuthMailerOpts["onSendFailure"]
}): Promise<void> {
  // SRC-312: only "no provider configured" falls back to the dev
  // log — a real provider failure is never swallowed, in any
  // environment. The branch keys on the resolved provider, never on
  // NODE_ENV alone (a staging deploy with NODE_ENV unset used to log
  // live verification links to stdout instead of failing).
  if (resolveEmailProvider() === "none") {
    if (process.env.NODE_ENV === "production") {
      // Loud failure: without a mailer, verification/reset can never complete.
      throw new Error(
        `Cannot send ${kind} email: no email provider is configured ` +
          `(set RESEND_API_KEY or SMTP_HOST/SMTP_USER/SMTP_PASS).`
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
    return
  }
  try {
    await sendPlatformEmail({ to, subject, html })
    return
  } catch (err) {
    const cause = err instanceof Error ? err.message : "unknown"
    // EML-009: the failure is visible — recipient + kind at error
    // level — and leaves a durable, retryable record when the caller
    // supplied one. The error still propagates with its real cause
    // (SRC-312): Better Auth must not report the email as sent.
    console.error(
      `[auth-email] Failed to send ${kind} email to ${to}: ${cause}`
    )
    if (onSendFailure) {
      try {
        await onSendFailure({ kind, to, subject, html, url })
      } catch (recordErr) {
        console.error(
          `[auth-email] Failed to record the failed ${kind} email to ${to} for retry: ${
            recordErr instanceof Error ? recordErr.message : "unknown"
          }`
        )
      }
    }
    throw new Error(`Cannot send ${kind} email to ${to}: ${cause}`, {
      cause: err,
    })
  }
}

/** Better Auth `emailVerification.sendVerificationEmail` callback.
    `locale` is the recipient's stored locale ("en" | "ur"); the
    auth factory resolves it from the user row and passes it through. */
export async function sendVerificationEmail({
  user,
  url,
  locale,
  onSendFailure,
}: {
  user: AuthEmailUser
  url: string
  locale?: string
  onSendFailure?: AuthMailerOpts["onSendFailure"]
}): Promise<void> {
  const t = getEmailTranslator(locale ?? "en")
  const html = await render(
    VerifyEmail({
      userName: user.name,
      url,
      accentColor: ACCENT_COLOR,
      footerText: t("authFooter"),
      locale,
    })
  )
  await deliverOrLog({
    kind: "verification",
    to: user.email,
    subject: t("authVerifySubject"),
    html,
    url,
    onSendFailure,
  })
}

/** Better Auth `emailAndPassword.sendResetPassword` callback. */
export async function sendPasswordResetEmail({
  user,
  url,
  locale,
  onSendFailure,
}: {
  user: AuthEmailUser
  url: string
  locale?: string
  onSendFailure?: AuthMailerOpts["onSendFailure"]
}): Promise<void> {
  const t = getEmailTranslator(locale ?? "en")
  const html = await render(
    ResetPasswordEmail({
      userName: user.name,
      url,
      accentColor: ACCENT_COLOR,
      footerText: t("authFooter"),
      locale,
    })
  )
  await deliverOrLog({
    kind: "password reset",
    to: user.email,
    subject: t("resetSubject"),
    html,
    url,
    onSendFailure,
  })
}

/** DOC-003: renders the account-approved mail (no direct send — the
    notifications outbox owns delivery, like the auth-mail fallback).
    `locale` is the recipient's stored locale ("en" | "ur"); the
    caller resolves it from the user row and passes it through. */
export async function renderAccountApprovedEmail({
  user,
  url,
  locale,
}: {
  user: AuthEmailUser
  url: string
  locale?: string
}): Promise<{ html: string; subject: string }> {
  const t = getEmailTranslator(locale ?? "en")
  const html = await render(
    AccountApproved({
      userName: user.name,
      url,
      accentColor: ACCENT_COLOR,
      footerText: t("authFooter"),
      locale,
    })
  )
  return { html, subject: t("accountApprovedSubject") }
}
