"use client"

import { useState } from "react"
import { authClient } from "@sendcms/auth/client"

import { ChangeEmailSchema } from "@sendcms/users/validators"
import { apiFetch } from "@sendcms/shared"

import { Button, Input, Label } from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"

export function ChangeEmailForm({ currentEmail }: { currentEmail: string }) {
  const { t } = useTranslation("account")
  const [email, setEmail] = useState("")
  const [currentPassword, setCurrentPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const parsed = ChangeEmailSchema.safeParse({ email })
    if (!parsed.success) {
      // The schema's message is English-only; the account domain already
      // carries its translated twin, so show that instead.
      setError(t("emailInvalid"))
      return
    }
    if (parsed.data.email.toLowerCase() === currentEmail.toLowerCase()) {
      setError(t("emailSame"))
      return
    }
    if (!currentPassword) {
      setError(t("currentPasswordRequired"))
      return
    }
    setLoading(true)
    // SEC-007: changing the email requires a server-enforced step-up
    // proof — re-enter the password to mint one bound to this action,
    // then send the change. Without the proof the api route refuses
    // the change with 403.
    try {
      await apiFetch<{ verifiedUntil: string }>("/api/v1/step-up/verify", {
        method: "POST",
        body: JSON.stringify({
          password: currentPassword,
          action: "change-email",
        }),
      })
    } catch (err) {
      setLoading(false)
      setError(err instanceof Error ? err.message : t("emailChangeFailed"))
      return
    }
    // The verification email goes to the NEW address; the change applies
    // only after that address is verified. The callback must be
    // ABSOLUTE (SEC-002): a relative path resolves against the api
    // origin, which has no /dashboard/account route and 404s. This
    // page runs on the dashboard app, so its own origin is the right one.
    const { error } = await authClient.changeEmail({
      newEmail: parsed.data.email,
      callbackURL: `${window.location.origin}/dashboard/account`,
    })
    setLoading(false)
    if (error) {
      setError(error.message ?? t("emailChangeFailed"))
      return
    }
    setSentTo(parsed.data.email)
  }

  if (sentTo) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("verificationLinkSentPrefix")}{" "}
        <span className="font-medium text-foreground">{sentTo}</span>
        {t("verificationLinkSentSuffix")}
      </p>
    )
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="account-new-email">{t("newEmailLabel")}</Label>
        <Input
          id="account-new-email"
          type="email"
          autoComplete="email"
          placeholder="new@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <p className="text-xs text-muted-foreground">{t("newEmailHint")}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="account-email-current-password">
          {t("currentPasswordLabel")}
        </Label>
        <Input
          id="account-email-current-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={loading}>
        {loading ? t("sending") : t("changeEmail")}
      </Button>
    </form>
  )
}
