import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import Link from "next/link"
import { AuthShell } from "../auth-shell"
import { ForgotPasswordForm } from "./forgot-password-form"

// PRF-037: each auth page has a distinct tab title (the layout
// template appends "— SendCMS Dashboard").
export const metadata: Metadata = {
  title: "Forgot password",
  description: "Reset your SendCMS dashboard password by email.",
}

export default async function ForgotPasswordPage() {
  const session = await auth()
  if (session) redirect("/dashboard")

  return (
    <AuthShell
      title="Forgot your password?"
      description="Enter your account email and we'll send you a reset link."
    >
      <ForgotPasswordForm />

      <p className="text-center text-sm text-muted-foreground">
        Remembered it?{" "}
        <Link
          href="/sign-in"
          className="font-medium text-foreground underline underline-offset-4"
        >
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  )
}
