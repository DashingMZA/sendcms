import type { NextRequest } from "next/server"
import { createEmailVerificationToken } from "better-auth/api"
import { betterAuth } from "@/lib/auth"
import { sendVerificationEmail as sendPlatformVerificationEmail } from "@sendcms/email"
import type { AdminEmailSender } from "@sendcms/admin-users"

// Builds the email sender the admin user-management service needs for
// require-verification / password-reset.
//
// Verification (ADM-001) does NOT go through the session-bound
// `betterAuth.api.sendVerificationEmail` endpoint: with the admin's
// session attached it throws EMAIL_MISMATCH (the target's email never
// equals the admin's), and without a session it silently sends
// nothing for an already-verified user — either way the action could
// never send. Instead the token is minted directly with Better Auth's
// own `createEmailVerificationToken` (the same signed JWT the sign-up
// flow mints, 24h TTL) and mailed through the platform mailer
// (`@sendcms/email`) the sign-up flow's callback uses, with no
// session involved at all.
//
// Password reset keeps the old path: it already works (200), and the
// request headers are forwarded so Better Auth's origin checks see a
// real browser request.
export function createAdminEmailSender(req: NextRequest): AdminEmailSender {
  const headers = req.headers
  return {
    sendVerificationEmail: async ({ email, name, userId }) => {
      const secret = betterAuth.options.secret ?? process.env.BETTER_AUTH_SECRET
      if (!secret) {
        throw new Error(
          "BETTER_AUTH_SECRET is not set, so no verification email can be sent."
        )
      }
      const expiresIn =
        betterAuth.options.emailVerification?.expiresIn ?? 60 * 60 * 24
      const token = await createEmailVerificationToken(
        secret,
        email,
        undefined,
        expiresIn,
        userId ? { userId } : undefined
      )
      // The link must land on the DASHBOARD app, not the api app:
      // the /verify-email page lives there
      // (apps/dashboard/app/(auth)/verify-email) and the api app has
      // no such route (GET /verify-email 404s). The token itself is
      // verified by the api's /api/auth/verify-email endpoint, which
      // the dashboard page calls — the host only decides which app
      // renders the page. NEXT_PUBLIC_DASHBOARD_URL is the api app's
      // documented dashboard origin (same fallback as the
      // notification-confirm route).
      const dashboardURL = (
        process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3002"
      ).replace(/\/$/, "")
      const url =
        `${dashboardURL}/verify-email?token=${token}` +
        `&callbackURL=${encodeURIComponent("/dashboard/account")}`
      await sendPlatformVerificationEmail({
        user: { name: name ?? "", email },
        url,
      })
    },
    sendPasswordReset: async (email: string) => {
      await betterAuth.api.requestPasswordReset({
        headers,
        body: { email, redirectTo: "/reset-password" },
      })
    },
  }
}
