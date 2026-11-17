import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import Link from "next/link"
import { AuthShell } from "../auth-shell"
import { ResetPasswordForm } from "./reset-password-form"

/**
 * The reset-password page. Better Auth's reset email links to
 * /api/auth/reset-password/:token, which validates the token and redirects
 * here with ?token=… — so the token comes from the query string, not the
 * path. (An earlier /reset-password/[token] route never received the
 * redirect and was removed.)
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const session = await auth()
  if (session) redirect("/dashboard")
  const { token } = await searchParams

  return (
    <AuthShell
      title="Choose a new password"
      description="Enter a new password for your account."
    >
      {token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            This reset link is missing its token.
          </p>
          <p className="text-sm text-muted-foreground">
            <Link
              href="/forgot-password"
              className="font-medium text-foreground underline underline-offset-4"
            >
              Request a new reset link
            </Link>
            .
          </p>
        </div>
      )}
    </AuthShell>
  )
}
