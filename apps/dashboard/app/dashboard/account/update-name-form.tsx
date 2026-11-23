"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { authClient } from "@sendcms/auth/client"

import { UpdateProfileSchema } from "@sendcms/users/validators"

import { Button, Input, Label } from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"

export function UpdateNameForm({
  currentName,
}: {
  currentName: string | null
}) {
  const { t } = useTranslation("account")
  const router = useRouter()
  const [name, setName] = useState(currentName ?? "")
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    const parsed = UpdateProfileSchema.safeParse({ name })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("nameRequired"))
      return
    }
    setLoading(true)
    const { error } = await authClient.updateUser({ name: parsed.data.name })
    setLoading(false)
    if (error) {
      setError(error.message ?? t("nameUpdateFailed"))
      return
    }
    setMessage(t("nameUpdated"))
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="account-name">{t("nameLabel")}</Label>
        <Input
          id="account-name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
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
        {loading ? t("saving") : t("saveName")}
      </Button>
    </form>
  )
}
