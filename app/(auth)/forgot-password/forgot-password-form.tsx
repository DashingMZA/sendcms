"use client"

import { useState } from "react"
import { authClient } from "@sendcms/auth/client"

import { ForgotPasswordSchema } from "@sendcms/users/validators"

import { Button, Input, Label } from "@sendcms/ui"

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const parsed = ForgotPasswordSchema.safeParse({ email })
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? "Enter a valid email address."
      )
      return
    }
    setLoading(true)
    // The endpoint always returns the same message (even for unknown
    // emails) so the form can't leak whether an address is registered.
    // redirectTo is REQUIRED: the reset email links to
    // /api/auth/reset-password/:token, which validates the token and
    // redirects to redirectTo with ?token=… — without it the link lands
    // on an error instead of this app's /reset-password page.
    const { error } = await authClient.requestPasswordReset({
      email: parsed.data.email,
      redirectTo: "/reset-password",
    })
    setLoading(false)
    if (error) {
      setError(error.message ?? "Couldn't send the reset email.")
      return
    }
    setSent(true)
  }

  if (sent) {
    return (
      <p className="text-sm text-muted-foreground">
        If an account exists for{" "}
        <span className="font-medium text-foreground">{email}</span>, a
        password-reset link is on its way. The link expires in 1 hour.
      </p>
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="forgot-email">Email</Label>
        <Input
          id="forgot-email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" className="w-full" size="lg" disabled={loading}>
        {loading ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  )
}
