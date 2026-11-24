import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import Link from "next/link"
import { getConfiguredOAuthProviders } from "@sendcms/auth"

import { AuthShell } from "../auth-shell"
import { SocialSignInButtons } from "../social-sign-in-buttons"
import { EmailSignInForm } from "./email-sign-in-form"
import { marketingTermsURL } from "@/lib/app-links"
import { resolveSignInCallbackURL } from "@/lib/callback-url"

// The sign-in page honours `?callbackURL=` (Phase 16, Wave 2 —
// SRC-116): the dashboard proxy appends the deep link the user
// asked for, and the admin proxy an absolute admin URL. The value is
// validated (dashboard/admin origin only) before it reaches either
// form, so a crafted link can never redirect elsewhere.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackURL?: string }>
}) {
  const session = await auth()
  const { callbackURL } = await searchParams
  const callback = resolveSignInCallbackURL(callbackURL)
  if (session) redirect(callbackURL ? callback : "/dashboard")
  const providers = getConfiguredOAuthProviders()

  return (
    <AuthShell
      title="Welcome back"
      description="Sign in to your dashboard to manage forms and submissions."
    >
      <SocialSignInButtons providers={providers} callbackURL={callback} />

      <div className="flex items-center gap-4">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">
          or continue with email
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <EmailSignInForm callbackURL={callback} />

      <p className="text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{" "}
        <Link
          href="/sign-up"
          className="font-medium text-foreground underline underline-offset-4"
        >
          Sign up
        </Link>
      </p>

      <p className="text-center text-xs text-muted-foreground">
        By signing in you agree to our{" "}
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
