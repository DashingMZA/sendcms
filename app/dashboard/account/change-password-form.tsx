"use client"

import { useState } from "react"
import { authClient } from "@/lib/auth-client"
import { ChangePasswordSchema } from "@/lib/validators/auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    const parsed = ChangePasswordSchema.safeParse({
      currentPassword,
      newPassword,
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the passwords.")
      return
    }
    setLoading(true)
    const { error } = await authClient.changePassword({
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
      revokeOtherSessions: true,
    })
    setLoading(false)
    if (error) {
      setError(error.message ?? "Couldn't change your password.")
      return
    }
    setCurrentPassword("")
    setNewPassword("")
    setMessage("Password changed. Your other sessions were signed out.")
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="account-current-password">Current password</Label>
        <Input
          id="account-current-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="account-new-password">New password</Label>
        <Input
          id="account-new-password"
          type="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      <Button type="submit" disabled={loading}>
        {loading ? "Changing…" : "Change password"}
      </Button>
    </form>
  )
}
