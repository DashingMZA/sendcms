import nodemailer from "nodemailer"
import type SMTPTransport from "nodemailer/lib/smtp-transport"

/**
 * Platform SMTP transport for transactional auth mail (email verification,
 * password reset). Reads SMTP_* env vars — the platform's own mailbox.
 * (Per-site SMTP was removed with the comment system.)
 *
 * Returns null when unconfigured; callers decide what to do (see
 * lib/email/auth-mailer.ts). Never enables nodemailer's logger/debug
 * (audit finding: the per-site transport logs credentials-adjacent output
 * in production).
 */
export function buildPlatformTransporter() {
  const host = process.env.SMTP_HOST
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  if (!host || !user || !pass) return null

  const port = Number(process.env.SMTP_PORT ?? 465)
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    // SRC-313: STARTTLS is required, never opportunistic — on port
    // 587 a server (or MITM) that does not offer STARTTLS must fail
    // the send instead of carrying SMTP_USER/SMTP_PASS in plaintext.
    // Harmless on port 465, where `secure` already implies TLS.
    requireTLS: true,
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  } as SMTPTransport.Options)
}

/**
 * The platform sender address, verbatim from env: SMTP_FROM may be a full
 * "Name <address>" mailbox or a bare address. Pass it through
 * formatFromAddress() before using it as a From header — never wrap it in
 * another "Name <...>" pair (see transport.ts).
 */
export function getPlatformFromAddress(): string {
  if (process.env.SMTP_FROM) return process.env.SMTP_FROM
  const user = process.env.SMTP_USER
  if (user && user.includes("@")) return user
  return "noreply@example.com"
}
