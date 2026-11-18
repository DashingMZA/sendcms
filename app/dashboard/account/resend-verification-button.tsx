"use client"

import { useState } from "react"
import { authClient } from "@/lib/auth-client"
import { Button } from "@sendcms/ui"

export function ResendVerificationButton({ email }: { email: string }) {
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function resend() {
    setError(null)
    setLoading(true)
    const { error } = await authClient.sendVerificationEmail({
      email,
      callbackURL: "/dashboard/account",
    })
    setLoading(false)
    if (error) {
      setError(error.message ?? "Couldn't resend the verification email.")
      return
    }
    setSent(true)
  }

  if (sent) {
    return (
      <p className="text-sm text-muted-foreground">
        Verification email sent to {email}. Check your inbox.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        onClick={resend}
        disabled={loading}
      >
        {loading ? "Sending…" : "Resend verification email"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
