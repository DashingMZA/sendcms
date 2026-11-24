"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { authClient } from "@sendcms/auth/client"

import { Button, Input, Label } from "@sendcms/ui"

/**
 * Verifies the email token from the link (sent by
 * `emailVerification.sendVerificationEmail` as /verify-email?token=…).
 * On success the user is signed in (autoSignInAfterVerification) and sent
 * to the callback URL. On failure the page explains why and offers a
 * resend — the token alone doesn't carry the email, so the user types it.
 */
export function VerifyEmailHandler({
  token,
  callbackURL,
}: {
  token?: string
  callbackURL?: string
}) {
  const router = useRouter()
  const started = useRef(false)
  const [status, setStatus] = useState<"pending" | "success" | "error">(
    token ? "pending" : "error"
  )
  const [error, setError] = useState<string | null>(
    token ? null : "This verification link is missing its token."
  )
  const [email, setEmail] = useState("")
  const [resent, setResent] = useState(false)
  const [resending, setResending] = useState(false)

  useEffect(() => {
    if (!token || started.current) return
    started.current = true
    authClient
      .verifyEmail({ query: { token } })
      .then(({ error }) => {
        if (error) {
          const code = (error as { code?: string }).code
          if (code === "EMAIL_ALREADY_VERIFIED") {
            setStatus("success")
            return
          }
          setStatus("error")
          setError(
            code === "TOKEN_EXPIRED"
              ? "This verification link has expired. Request a new one below."
              : (error.message ??
                  "This verification link is invalid. Request a new one below.")
          )
          return
        }
        setStatus("success")
        router.push(callbackURL || "/dashboard")
        router.refresh()
      })
      // Network/offline failure rejects instead of resolving with
      // { error } — without this the page stays on "Verifying your
      // email…" forever (SRC-106).
      .catch(() => {
        setStatus("error")
        setError(
          "Couldn't reach the server. Check your connection and try again below."
        )
      })
  }, [token, callbackURL, router])

  async function resend() {
    if (!email) return
    setResending(true)
    try {
      const { error } = await authClient.sendVerificationEmail({
        email,
        callbackURL: callbackURL || "/dashboard",
      })
      if (error) {
        setError(error.message ?? "Couldn't resend the verification email.")
        return
      }
      setResent(true)
    } catch {
      // A rejected send leaves resending=true and the button
      // permanently disabled without this (SRC-106).
      setError(
        "Couldn't reach the server. Check your connection and try again."
      )
    } finally {
      setResending(false)
    }
  }

  if (status === "pending") {
    return (
      <p className="text-sm text-muted-foreground">Verifying your email…</p>
    )
  }

  if (status === "success") {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium">Your email is verified.</p>
        <p className="text-sm text-muted-foreground">
          Taking you to your dashboard… If nothing happens,{" "}
          <Link
            href="/sign-in"
            className="font-medium text-foreground underline underline-offset-4"
          >
            sign in
          </Link>
          .
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {resent ? (
        <p className="text-sm text-muted-foreground">
          Verification email sent to {email}. Check your inbox.
        </p>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="verify-email">Email</Label>
          <Input
            id="verify-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button
            type="button"
            className="w-full"
            size="lg"
            disabled={resending || !email}
            onClick={resend}
          >
            {resending ? "Sending…" : "Resend verification email"}
          </Button>
        </div>
      )}
      <p className="text-center text-sm text-muted-foreground">
        <Link
          href="/sign-in"
          className="font-medium text-foreground underline underline-offset-4"
        >
          Back to sign in
        </Link>
      </p>
    </div>
  )
}
