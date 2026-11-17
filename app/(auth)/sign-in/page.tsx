import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import Link from "next/link"
import { Logo } from "@/components/logo"
import { SignInPanel } from "./sign-in-panel"
import { GoogleSignInButton } from "./google-sign-in-button"

export default async function SignInPage() {
  const session = await auth()
  if (session) redirect("/dashboard")

  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      {/* Left — brand panel */}
      <SignInPanel />
      {/* Right — sign-in form */}
      <div className="flex flex-col items-center justify-center px-6 py-16">
        {/* Mobile logo */}
        <Link href="/" className="mb-10 flex items-center lg:hidden">
          <Logo />
        </Link>

        <div className="w-full max-w-90 space-y-8">
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight text-pretty">
              Welcome back
            </h1>
            <p className="text-sm text-muted-foreground">
              Sign in to your dashboard to manage comments and sites.
            </p>
          </div>

          <GoogleSignInButton />

          <p className="text-center text-xs text-muted-foreground">
            By signing in you agree to our{" "}
            <a
              href="/terms"
              className="underline underline-offset-4 transition-colors hover:text-foreground"
            >
              Terms of Service
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  )
}
