"use client"

import { useState } from "react"
import { authClient } from "@/lib/auth-client"
import { ChangeEmailSchema } from "@/lib/validators/auth"
import { Button, Input, Label } from "@sendcms/ui"

export function ChangeEmailForm({ currentEmail }: { currentEmail: string }) {
  const [email, setEmail] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const parsed = ChangeEmailSchema.safeParse({ email })
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? "Enter a valid email address."
      )
      return
    }
    if (parsed.data.email.toLowerCase() === currentEmail.toLowerCase()) {
      setError("That's already your email address.")
      return
    }
    setLoading(true)
    // The verification email goes to the NEW address; the change applies
    // only after that address is verified.
    const { error } = await authClient.changeEmail({
      newEmail: parsed.data.email,
      callbackURL: "/dashboard/account",
    })
    setLoading(false)
    if (error) {
      setError(error.message ?? "Couldn't change your email.")
      return
    }
    setSentTo(parsed.data.email)
  }

  if (sentTo) {
    return (
      <p className="text-sm text-muted-foreground">
        We sent a verification link to{" "}
        <span className="font-medium text-foreground">{sentTo}</span>. Your
        email changes once you click it.
      </p>
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="account-new-email">New email</Label>
        <Input
          id="account-new-email"
          type="email"
          autoComplete="email"
          placeholder="new@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <p className="text-xs text-muted-foreground">
          A verification link goes to the new address first.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={loading}>
        {loading ? "Sending…" : "Change email"}
      </Button>
    </form>
  )
}
