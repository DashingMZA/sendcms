import nodemailer from "nodemailer"
import type SMTPTransport from "nodemailer/lib/smtp-transport"

/**
 * Platform SMTP transport for transactional auth mail (email verification,
 * password reset). Reads SMTP_* env vars — the platform's own mailbox, NOT
 * per-site SMTP (Site.smtp* is the legacy comment-notification config).
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
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  } as SMTPTransport.Options)
}

export function getPlatformFromAddress(): string {
  if (process.env.SMTP_FROM) return process.env.SMTP_FROM
  const user = process.env.SMTP_USER
  if (user && user.includes("@")) return user
  return "noreply@example.com"
}
