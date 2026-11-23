import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import Link from "next/link"
import { getConfiguredOAuthProviders } from "@sendcms/auth"

import { AuthShell } from "../auth-shell"
import { SocialSignInButtons } from "../social-sign-in-buttons"
import { SignUpForm } from "./sign-up-form"
import { marketingTermsURL } from "@/lib/app-links"

export default async function SignUpPage() {
  const session = await auth()
  if (session) redirect("/dashboard")
  const providers = getConfiguredOAuthProviders()

  return (
    <AuthShell
      title="Create your account"
      description="Sign up to collect form submissions from any site."
    >
      <SocialSignInButtons providers={providers} />

      <div className="flex items-center gap-4">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">
          or continue with email
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <SignUpForm />

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link
          href="/sign-in"
          className="font-medium text-foreground underline underline-offset-4"
        >
          Sign in
        </Link>
      </p>

      <p className="text-center text-xs text-muted-foreground">
        By signing up you agree to our{" "}
        <a
          href={marketingTermsURL()}
          className="underline underline-offset-4 transition-colors hover:text-foreground"
        >
          Terms of Service
        </a>
        .
      </p>
    </AuthShell>
  )
}
