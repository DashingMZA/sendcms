"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { authClient } from "@sendcms/auth/client"
import { dashboardCallbackURL } from "@/lib/callback-url"

import { SignInSchema } from "@sendcms/users/validators"

import { Button, Input, Label } from "@sendcms/ui"

// The post-sign-in landing URL, validated by the sign-in page
// (SRC-116): a deep link from the proxy (`/dashboard/inbox/<id>`) or
// an absolute admin URL. Defaults to /dashboard when the page was
// opened directly.
export function EmailSignInForm({
  callbackURL = dashboardCallbackURL(),
}: {
  callbackURL?: string
}) {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [needsVerification, setNeedsVerification] = useState(false)
  const [resent, setResent] = useState(false)
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setNeedsVerification(false)
    const parsed = SignInSchema.safeParse({ email, password })
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? "Check your email and password."
      )
      return
    }
    setLoading(true)
    const { error } = await authClient.signIn.email({
      email,
      password,
      callbackURL,
    })
    setLoading(false)
    if (error) {
      // Unverified email: the server refuses sign-in until verification.
      const code = (error as { code?: string }).code
      if (code === "EMAIL_NOT_VERIFIED") {
        setNeedsVerification(true)
        setError(
          "Your email isn't verified yet. Check your inbox for the verification link."
        )
      } else {
        setError(
          error.message ?? "Sign-in failed. Check your email and password."
        )
      }
      return
    }
    router.push(callbackURL)
    router.refresh()
  }

  async function resendVerification() {
    setError(null)
    const { error } = await authClient.sendVerificationEmail({
      email,
      callbackURL: dashboardCallbackURL(),
    })
    if (error) {
      setError(error.message ?? "Couldn't resend the verification email.")
      return
    }
    setResent(true)
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="signin-email">Email</Label>
        <Input
          id="signin-email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="signin-password">Password</Label>
          <Link
            href="/forgot-password"
            className="text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
          >
            Forgot password?
          </Link>
        </div>
        <Input
          id="signin-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {needsVerification && !resent && (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={resendVerification}
        >
          Resend verification email
        </Button>
      )}
      {resent && (
        <p className="text-sm text-muted-foreground">
          Verification email sent to {email}. Check your inbox.
        </p>
      )}

      <Button type="submit" className="w-full" size="lg" disabled={loading}>
        {loading ? "Signing in…" : "Sign in with email"}
      </Button>
    </form>
  )
}
