"use client"

import { useState } from "react"
import { authClient } from "@sendcms/auth/client"

import { Button } from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"

export function ResendVerificationButton({ email }: { email: string }) {
  const { t } = useTranslation("account")
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
      setError(error.message ?? t("resendFailed"))
      return
    }
    setSent(true)
  }

  if (sent) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("verificationSent", { email })}
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
        {loading ? t("sending") : t("resendVerification")}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
