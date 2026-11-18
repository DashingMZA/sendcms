"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { authClient } from "@/lib/auth-client"
import { ResetPasswordSchema } from "@/lib/validators/auth"
import { Button, Input, Label } from "@sendcms/ui"

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const parsed = ResetPasswordSchema.safeParse({ password })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the new password.")
      return
    }
    setLoading(true)
    const { error } = await authClient.resetPassword({
      newPassword: parsed.data.password,
      token,
    })
    setLoading(false)
    if (error) {
      // Expired/invalid tokens land here — the user needs a fresh link.
      setError(
        error.message ??
          "This reset link is invalid or expired. Request a new one."
      )
      return
    }
    router.push("/dashboard")
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="reset-password">New password</Label>
        <Input
          id="reset-password"
          type="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <p className="text-xs text-muted-foreground">
          At least 8 characters. The reset link expires 1 hour after it was
          sent.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" className="w-full" size="lg" disabled={loading}>
        {loading ? "Resetting…" : "Reset password"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Link expired?{" "}
        <Link
          href="/forgot-password"
          className="font-medium text-foreground underline underline-offset-4"
        >
          Request a new one
        </Link>
      </p>
    </form>
  )
}
