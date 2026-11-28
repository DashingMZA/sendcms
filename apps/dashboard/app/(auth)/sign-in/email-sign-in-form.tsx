"use client"

import { useEffect, useRef, useState } from "react"
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
  // PRF-028: which field the current error belongs to. The failing field
  // gets aria-invalid + aria-describedby (pointing at the role="alert"
  // paragraph) and receives focus once the error is rendered.
  const [errorField, setErrorField] = useState<"email" | "password" | null>(
    null
  )
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!errorField) return
    const target = errorField === "email" ? emailRef : passwordRef
    target.current?.focus()
  }, [errorField])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setErrorField(null)
    setNeedsVerification(false)
    const parsed = SignInSchema.safeParse({ email, password })
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? "Check your email and password."
      )
      const field = parsed.error.issues[0]?.path[0]
      setErrorField(field === "password" ? "password" : "email")
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
      } else if (code === "FAILED_TO_CREATE_SESSION") {
        // DOC-003 (Q5, combined copy): the account is not ACTIVE —
        // pending approval, suspended, or disabled. The endpoint
        // cannot distinguish them without leaking account state, so
        // one message covers all three.
        setError(
          "Your account isn't active. If you recently registered, an admin will review your account; if you believe this is a mistake, contact support."
        )
      } else {
        setError(
          error.message ?? "Sign-in failed. Check your email and password."
        )
      }
      // A failed sign-in is a credentials error — the email field is the
      // first field to re-check.
      setErrorField("email")
      return
    }
    router.push(callbackURL)
    router.refresh()
  }

  async function resendVerification() {
    setError(null)
    setErrorField(null)
    const { error } = await authClient.sendVerificationEmail({
      email,
      callbackURL: dashboardCallbackURL(),
    })
    if (error) {
      setError(error.message ?? "Couldn't resend the verification email.")
      setErrorField("email")
      return
    }
    setResent(true)
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="signin-email">Email</Label>
        <Input
          ref={emailRef}
          id="signin-email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          aria-invalid={errorField === "email"}
          aria-describedby={errorField === "email" ? "signin-error" : undefined}
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
          ref={passwordRef}
          id="signin-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          aria-invalid={errorField === "password"}
          aria-describedby={
            errorField === "password" ? "signin-error" : undefined
          }
        />
      </div>

      {error && (
        <p role="alert" id="signin-error" className="text-sm text-destructive">
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
