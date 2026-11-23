"use client"

import { useState } from "react"
import { authClient } from "@sendcms/auth/client"

import { ChangeEmailSchema } from "@sendcms/users/validators"

import { Button, Input, Label } from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"

export function ChangeEmailForm({ currentEmail }: { currentEmail: string }) {
  const { t } = useTranslation("account")
  const [email, setEmail] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const parsed = ChangeEmailSchema.safeParse({ email })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("emailInvalid"))
      return
    }
    if (parsed.data.email.toLowerCase() === currentEmail.toLowerCase()) {
      setError(t("emailSame"))
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
    <form onSubmit={onSubmit} className="space-y-3">
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
