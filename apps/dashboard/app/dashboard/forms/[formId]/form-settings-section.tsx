"use client"

import { useState } from "react"
import { useUpdateForm } from "@sendcms/forms/queries"
import type { FormDetailResponse } from "@sendcms/forms/queries"
import { useAiBillingMode } from "@sendcms/ai-settings/queries"
import { ApiClientError } from "@sendcms/shared"

import {
  Button,
  Callout,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from "@sendcms/ui"

import { format } from "date-fns"
import { useTranslation } from "@/components/dashboard/translation-provider"
import { FormSection } from "./form-section"

/** Digest timestamps arrive as Dates from the server render and as
    ISO strings after a client refetch — normalize either way. */
function formatDigestDate(value: Date | string): string {
  return format(new Date(value), "PPpp")
}

// The form's settings (Wave 10, SRC-118: split out of form-detail.tsx
// by concern). Owns the settings form state + save; the active toggle
// lives in the header card in form-detail.tsx, not here.
export function FormSettingsSection({ form }: { form: FormDetailResponse }) {
  const { t } = useTranslation("forms")
  const updateForm = useUpdateForm(form.id)

  const [name, setName] = useState(form.name)
  const [description, setDescription] = useState(form.description ?? "")
  const [successMessage, setSuccessMessage] = useState(
    form.successMessage ?? ""
  )
  const [redirectUrl, setRedirectUrl] = useState(form.redirectUrl ?? "")
  const [dailyLimit, setDailyLimit] = useState(
    form.dailyLimit != null ? String(form.dailyLimit) : ""
  )
  const [honeypotEnabled, setHoneypotEnabled] = useState(form.honeypotEnabled)
  const [turnstileEnabled, setTurnstileEnabled] = useState(
    form.turnstileEnabled
  )
  const [aiEnabled, setAiEnabled] = useState(form.aiEnabled)
  // AIM-025: name the resolved AI provider under the toggle — the
  // billing mode decides whose key a form's AI calls use. The query
  // is read-only; while it loads, the static description already
  // states what is sent and under whose terms.
  const { data: aiBillingMode } = useAiBillingMode()
  // EML-093: the digest preference lives here with the AI toggle —
  // the digest is a notification preference, not an AI feature.
  // Interval is the form's own value, else the platform default (24).
  const [digestEnabled, setDigestEnabled] = useState(form.digestEnabled)
  const [digestIntervalHours, setDigestIntervalHours] = useState(
    form.digestIntervalHours ?? 24
  )
  const [settingsError, setSettingsError] = useState<string | null>(null)

  async function onSaveSettings(e: React.FormEvent) {
    e.preventDefault()
    setSettingsError(null)
    try {
      await updateForm.mutateAsync({
        name,
        description: description || null,
        successMessage: successMessage || null,
        redirectUrl: redirectUrl || null,
        dailyLimit: dailyLimit ? Number(dailyLimit) : null,
        honeypotEnabled,
        turnstileEnabled,
        aiEnabled,
        digestEnabled,
        digestIntervalHours,
      })
    } catch (err) {
      setSettingsError(
        err instanceof ApiClientError ? err.message : t("saveFailed")
      )
    }
  }

  return (
    <FormSection
      title={t("settingsTitle")}
      description={t("settingsDescription")}
    >
      <form onSubmit={onSaveSettings} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="settings-name">{t("formNameLabel")}</Label>
            <Input
              id="settings-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-daily-limit">{t("dailyLimitLabel")}</Label>
            <Input
              id="settings-daily-limit"
              type="number"
              min={1}
              max={100000}
              placeholder={t("dailyLimitPlaceholder")}
              value={dailyLimit}
              onChange={(e) => setDailyLimit(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="settings-description">{t("descriptionLabel")}</Label>
          <Textarea
            id="settings-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="settings-success">{t("successMessageLabel")}</Label>
          <Input
            id="settings-success"
            autoComplete="off"
            placeholder={t("successMessagePlaceholder")}
            value={successMessage}
            onChange={(e) => setSuccessMessage(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="settings-redirect">{t("redirectUrlLabel")}</Label>
          <Input
            id="settings-redirect"
            type="url"
            autoComplete="off"
            placeholder="https://example.com/thanks"
            value={redirectUrl}
            onChange={(e) => setRedirectUrl(e.target.value)}
          />
        </div>
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div>
            <Label htmlFor="settings-honeypot">{t("honeypotLabel")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("honeypotDescription")}
            </p>
          </div>
          <Switch
            id="settings-honeypot"
            checked={honeypotEnabled}
            onCheckedChange={setHoneypotEnabled}
          />
        </div>
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div>
            <Label htmlFor="settings-turnstile">{t("turnstileLabel")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("turnstileDescription")}
            </p>
          </div>
          <Switch
            id="settings-turnstile"
            checked={turnstileEnabled}
            onCheckedChange={setTurnstileEnabled}
          />
        </div>
        {form.turnstileEnabled && form.turnstileConfigured === false && (
          // SDK-016: Turnstile is on but the API server has no
          // secret (TURNSTILE_SECRET_KEY unset), so every
          // submission to this form is rejected with 503. The flag
          // comes from the API (useForm) — the dashboard process
          // cannot know the API server's secret.
          <Callout role="alert">{t("turnstileServerMissing")}</Callout>
        )}
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div>
            <Label htmlFor="settings-ai">{t("aiLabel")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("aiDescription")}
            </p>
            {aiBillingMode === "BYOK" && (
              <p className="text-xs text-muted-foreground">
                {t("aiProviderByok")}
              </p>
            )}
            {aiBillingMode === "PLATFORM" && (
              <p className="text-xs text-muted-foreground">
                {t("aiProviderPlatform")}
              </p>
            )}
          </div>
          <Switch
            id="settings-ai"
            checked={aiEnabled}
            onCheckedChange={setAiEnabled}
          />
        </div>
        {/* EML-093/DSH-304: the digest controls + state. The toggle
            is independent of AI; the frequency picks the per-form
            interval; last/next come from the server (same shape as
            the notifications page's digest summary). */}
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="settings-digest">{t("digestLabel")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("digestDescription")}
              </p>
            </div>
            <Switch
              id="settings-digest"
              checked={digestEnabled}
              onCheckedChange={setDigestEnabled}
            />
          </div>
          {digestEnabled && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-2">
                <Label htmlFor="settings-digest-frequency">
                  {t("digestFrequencyLabel")}
                </Label>
                <Select
                  value={String(digestIntervalHours)}
                  onValueChange={(value) =>
                    setDigestIntervalHours(Number(value))
                  }
                >
                  <SelectTrigger
                    id="settings-digest-frequency"
                    className="w-48"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="24">{t("digestDaily")}</SelectItem>
                    <SelectItem value="168">{t("digestWeekly")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            {t("digestLast")}{" "}
            {form.lastDigestAt
              ? formatDigestDate(form.lastDigestAt)
              : t("digestNever")}
            {" · "}
            {t("digestNext")}{" "}
            {form.digestNextAt
              ? formatDigestDate(form.digestNextAt)
              : t("digestNextPending")}
          </p>
        </div>
        {settingsError && (
          <p role="alert" className="text-sm text-destructive">
            {settingsError}
          </p>
        )}
        <div>
          <Button type="submit" disabled={updateForm.isPending}>
            {updateForm.isPending ? t("saving") : t("saveSettings")}
          </Button>
        </div>
      </form>
    </FormSection>
  )
}
