import type { NextRequest } from "next/server"
import { betterAuth } from "@/lib/auth"
import type { AdminEmailSender } from "@sendcms/admin-users"

// Builds the email sender the admin user-management service needs for
// require-verification / password-reset. The sends go through Better
// Auth's server API — the same endpoints the dashboard's client flows
// hit — so Better Auth generates the token and the platform mailer
// (Resend → SMTP, wired in packages/auth) sends the email. The incoming
// request headers are forwarded so Better Auth's origin checks see a
// real browser request.
export function createAdminEmailSender(req: NextRequest): AdminEmailSender {
  const headers = req.headers
  return {
    sendVerificationEmail: async (email: string) => {
      await betterAuth.api.sendVerificationEmail({
        headers,
        body: { email, callbackURL: "/dashboard/account" },
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
