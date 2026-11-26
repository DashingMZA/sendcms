import { formatFromAddress } from "./transport"
import {
  buildPlatformTransporter,
  getPlatformFromAddress,
} from "./platform-transport"

// Platform email provider (Phase 8). One send path for every
// platform email — auth mail (verification/reset) and submission
// notifications. Priority:
//   1. Resend (RESEND_API_KEY) — the recommended provider. No new
//      dependency: Resend's REST API is a plain POST, called with
//      fetch (which the tests can stub).
//   2. Platform SMTP (SMTP_HOST/SMTP_USER/SMTP_PASS) — the Phase 2
//      fallback, kept working.
//   3. None — callers fail loudly (production) or log (dev); the
//      outbox turns this into a FAILED job with a retry, never a
//      silently dropped email.

export type EmailProvider = "resend" | "smtp" | "none"

export function resolveEmailProvider(
  env: NodeJS.ProcessEnv = process.env
): EmailProvider {
  if (env.RESEND_API_KEY) return "resend"
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) return "smtp"
  return "none"
}

export type SendEmailInput = {
  to: string
  subject: string
  html: string
  text?: string
  // Extra headers for the provider send — e.g. List-Unsubscribe
  // (EML-011). Passed through to Resend / SMTP verbatim.
  headers?: Record<string, string>
}

export type SendEmailResult = {
  messageId: string
  provider: EmailProvider
}

const RESEND_API_URL = "https://api.resend.com/emails"
const SEND_TIMEOUT_MS = 15_000

function getResendFromAddress(): string {
  // Resend only sends from domains verified in the Resend dashboard,
  // so the sender is its own env var — never silently reuse an
  // SMTP address that Resend would reject.
  return process.env.RESEND_FROM ?? getPlatformFromAddress()
}

// EML-008: RESEND_FROM is validated, never silently fallen back to
// `noreply@example.com`. When the Resend provider is selected, the
// sender must be present, parse as an address, and — when the
// operator configured a verified-domain list
// (RESEND_VERIFIED_DOMAINS, comma-separated) — belong to one of those
// domains. Without a configured list the domain cannot be checked
// against Resend, so only presence + shape are enforced (and the
// `example.com` placeholder is refused outright: Resend can never
// have verified it). Returns the sender address on success, or the
// named error to throw / surface in admin health.
export function validateResendSender(
  env: NodeJS.ProcessEnv = process.env
): { ok: true; from: string; domain: string } | { ok: false; error: string } {
  const raw = env.RESEND_FROM ?? ""
  const from = raw.trim()
  if (!from) {
    return {
      ok: false,
      error:
        "RESEND_FROM is not set: Resend cannot send without a verified sender address (set RESEND_FROM to an address on a domain verified in the Resend dashboard).",
    }
  }
  // Accept a bare address or a "Name <address>" mailbox.
  const bare = from.match(/<([^<>]+)>/)?.[1]?.trim() ?? from
  const at = bare.lastIndexOf("@")
  const domain = at > 0 ? bare.slice(at + 1).toLowerCase() : ""
  if (
    at <= 0 ||
    !domain ||
    domain.includes(" ") ||
    !domain.includes(".") ||
    bare.includes(" ")
  ) {
    return {
      ok: false,
      error: `RESEND_FROM is not a valid email address: "${from}". Set it to an address on a domain verified in the Resend dashboard.`,
    }
  }
  if (domain === "example.com") {
    return {
      ok: false,
      error:
        'RESEND_FROM uses the placeholder domain "example.com", which Resend cannot have verified. Set RESEND_FROM to an address on a domain verified in the Resend dashboard.',
    }
  }
  const verified = (env.RESEND_VERIFIED_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
  if (verified.length > 0 && !verified.includes(domain)) {
    return {
      ok: false,
      error: `RESEND_FROM domain "${domain}" is not in RESEND_VERIFIED_DOMAINS (${verified.join(", ")}). Use an address on a verified domain.`,
    }
  }
  return { ok: true, from, domain }
}

async function sendViaResend(input: SendEmailInput): Promise<string> {
  // EML-008: fail fast with the named RESEND_FROM error instead of
  // sending (and retrying 5×) only for Resend to reject the sender.
  const sender = validateResendSender()
  if (!sender.ok) throw new Error(sender.error)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: formatFromAddress("SendCMS", getResendFromAddress()),
        to: [input.to],
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
      }),
      signal: controller.signal,
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(
        `Resend rejected the email (${res.status}): ${body.message ?? body.name ?? "unknown error"}`
      )
    }
    if (typeof body.id !== "string" || !body.id) {
      throw new Error("Resend returned no message id.")
    }
    return body.id
  } finally {
    clearTimeout(timer)
  }
}

async function sendViaSmtp(input: SendEmailInput): Promise<string> {
  const transport = buildPlatformTransporter()
  if (!transport) {
    throw new Error("SMTP is not configured.")
  }
  const info = await transport.sendMail({
    from: formatFromAddress("SendCMS", getPlatformFromAddress()),
    to: input.to,
    subject: input.subject,
    html: input.html,
    ...(input.text ? { text: input.text } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
  })
  return info.messageId ?? "smtp-sent"
}

/** Sends one platform email through the configured provider. Throws
    when no provider is configured — callers decide whether that is a
    loud failure (auth mail) or a retryable job failure (outbox). */
export async function sendPlatformEmail(
  input: SendEmailInput
): Promise<SendEmailResult> {
  const provider = resolveEmailProvider()
  if (provider === "resend") {
    return { messageId: await sendViaResend(input), provider }
  }
  if (provider === "smtp") {
    return { messageId: await sendViaSmtp(input), provider }
  }
  throw new Error(
    "No email provider configured (set RESEND_API_KEY or SMTP_HOST/SMTP_USER/SMTP_PASS)."
  )
}
