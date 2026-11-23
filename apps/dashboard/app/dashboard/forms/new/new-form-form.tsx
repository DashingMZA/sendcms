"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useCreateForm } from "@sendcms/forms/queries"
import { ApiClientError } from "@sendcms/shared"

import { Button, Input, Label, Switch, Textarea } from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"

export function NewFormForm() {
  const { t } = useTranslation("forms")
  const router = useRouter()
  const createForm = useCreateForm()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [successMessage, setSuccessMessage] = useState("")
  const [redirectUrl, setRedirectUrl] = useState("")
  const [dailyLimit, setDailyLimit] = useState("")
  const [honeypotEnabled, setHoneypotEnabled] = useState(true)
  const [turnstileEnabled, setTurnstileEnabled] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const created = await createForm.mutateAsync({
        name,
        description: description || undefined,
        successMessage: successMessage || undefined,
        redirectUrl: redirectUrl || undefined,
        dailyLimit: dailyLimit ? Number(dailyLimit) : undefined,
        honeypotEnabled,
        turnstileEnabled,
      })
      router.push(`/dashboard/forms/${created.id}`)
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("createFailed"))
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-lg space-y-6">
      <div className="space-y-2">
        <Label htmlFor="name">{t("formNameLabel")}</Label>
        <Input
          id="name"
          type="text"
          autoComplete="off"
          placeholder={t("formNamePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">{t("descriptionOptionalLabel")}</Label>
        <Textarea
          id="description"
          placeholder={t("descriptionPlaceholder")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="successMessage">
          {t("successMessageOptionalLabel")}
        </Label>
        <Input
          id="successMessage"
          type="text"
          autoComplete="off"
          placeholder={t("successMessagePlaceholder")}
          value={successMessage}
          onChange={(e) => setSuccessMessage(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="redirectUrl">{t("redirectUrlOptionalLabel")}</Label>
        <Input
          id="redirectUrl"
          type="url"
          autoComplete="off"
          placeholder="https://example.com/thanks"
          value={redirectUrl}
          onChange={(e) => setRedirectUrl(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t("redirectHint")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="dailyLimit">{t("dailyLimitOptionalLabel")}</Label>
        <Input
          id="dailyLimit"
          type="number"
          min={1}
          max={100000}
          placeholder={t("dailyLimitPlaceholder")}
          value={dailyLimit}
          onChange={(e) => setDailyLimit(e.target.value)}
        />
      </div>

      <div className="flex items-center justify-between rounded-lg border p-4">
        <div>
          <Label htmlFor="honeypot">{t("honeypotLabel")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("honeypotDescription")}
          </p>
        </div>
        <Switch
          id="honeypot"
          checked={honeypotEnabled}
          onCheckedChange={setHoneypotEnabled}
        />
      </div>

      <div className="flex items-center justify-between rounded-lg border p-4">
        <div>
          <Label htmlFor="turnstile">{t("turnstileLabel")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("turnstileDescription")}
          </p>
        </div>
        <Switch
          id="turnstile"
          checked={turnstileEnabled}
          onCheckedChange={setTurnstileEnabled}
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" disabled={createForm.isPending}>
        {createForm.isPending ? t("creating") : t("createForm")}
      </Button>
      <p className="text-xs text-muted-foreground">{t("newFormNote")}</p>
    </form>
  )
}
