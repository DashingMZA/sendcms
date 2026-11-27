"use client"

import { useEffect, useRef, useState } from "react"
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
  // PRF-028: which field the current error belongs to — it gets
  // aria-invalid + aria-describedby (pointing at the role="alert"
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
    const parsed = ChangeEmailSchema.safeParse({ email })
    if (!parsed.success) {
      // The schema's message is English-only; the account domain already
      // carries its translated twin, so show that instead.
      setError(t("emailInvalid"))
      setErrorField("email")
      return
    }
    if (parsed.data.email.toLowerCase() === currentEmail.toLowerCase()) {
      setError(t("emailSame"))
      setErrorField("email")
      return
    }
    if (!currentPassword) {
      setError(t("currentPasswordRequired"))
      setErrorField("password")
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
      // The step-up proof is the re-entered password.
      setErrorField("password")
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
      setErrorField("email")
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
          ref={emailRef}
          id="account-new-email"
          type="email"
          autoComplete="email"
          placeholder="new@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          aria-invalid={errorField === "email"}
          aria-describedby={
            errorField === "email" ? "change-email-error" : undefined
          }
        />
        <p className="text-xs text-muted-foreground">{t("newEmailHint")}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="account-email-current-password">
          {t("currentPasswordLabel")}
        </Label>
        <Input
          ref={passwordRef}
          id="account-email-current-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          aria-invalid={errorField === "password"}
          aria-describedby={
            errorField === "password" ? "change-email-error" : undefined
          }
        />
      </div>
      {error && (
        <p
          role="alert"
          id="change-email-error"
          className="text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <Button type="submit" disabled={loading}>
        {loading ? t("sending") : t("changeEmail")}
      </Button>
    </form>
  )
}
