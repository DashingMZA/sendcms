"use client"

import { useState } from "react"
import { authClient } from "@sendcms/auth/client"

import { ChangePasswordSchema } from "@sendcms/users/validators"
import { apiFetch } from "@sendcms/shared"

import { Button, Input, Label } from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"

export function ChangePasswordForm() {
  const { t } = useTranslation("account")
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
      // The schema's messages are English-only — translate by field and
      // issue code instead of showing them. Anything unmapped (e.g. a
      // 129-character password) falls back to the generic key.
      const issue = parsed.error.issues[0]
      const field = issue?.path[0]
      if (field === "currentPassword") {
        setError(t("currentPasswordRequired"))
      } else if (field === "newPassword" && issue?.code === "custom") {
        setError(t("passwordsDifferent"))
      } else if (field === "newPassword" && issue?.code === "too_small") {
        setError(t("newPasswordMin"))
      } else {
        setError(t("passwordsInvalid"))
      }
      return
    }
    setLoading(true)
    // SEC-007: changing the password requires a server-enforced
    // step-up proof on top of the current password — re-enter the
    // current password to mint one bound to this action, then send
    // the change. The same password serves as both the proof and
    // Better Auth's current-password check. Without the proof the api
    // route refuses the change with 403.
    try {
      await apiFetch<{ verifiedUntil: string }>("/api/v1/step-up/verify", {
        method: "POST",
        body: JSON.stringify({
          password: parsed.data.currentPassword,
          action: "change-password",
        }),
      })
    } catch (err) {
      setLoading(false)
      setError(err instanceof Error ? err.message : t("passwordChangeFailed"))
      return
    }
    const { error } = await authClient.changePassword({
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
      revokeOtherSessions: true,
    })
    setLoading(false)
    if (error) {
      setError(error.message ?? t("passwordChangeFailed"))
      return
    }
    setCurrentPassword("")
    setNewPassword("")
    setMessage(t("passwordChanged"))
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="account-current-password">
          {t("currentPasswordLabel")}
        </Label>
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
        <Label htmlFor="account-new-password">{t("newPasswordLabel")}</Label>
        <Input
          id="account-new-password"
          type="password"
          autoComplete="new-password"
          placeholder={t("newPasswordPlaceholder")}
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
        {loading ? t("changing") : t("changePassword")}
      </Button>
    </form>
  )
}
