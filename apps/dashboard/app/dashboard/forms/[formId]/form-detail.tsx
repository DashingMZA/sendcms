"use client"

import Link from "next/link"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { useDomains } from "@sendcms/domains/queries"
import {
  useAddNotificationEmail,
  useDeleteForm,
  useDeleteNotificationEmail,
  useForm,
  useLinkDomain,
  useResendNotificationConfirmation,
  useUnlinkDomain,
  useUpdateForm,
  useUpdateNotificationEmail,
} from "@sendcms/forms/queries"
import type { FormDetail, FormDetailResponse } from "@sendcms/forms/queries"
import { getFormEmbedWarnings } from "@sendcms/forms/queries"
import { useSendTestEmail } from "@sendcms/notifications/queries"
import { useAiBillingMode } from "@sendcms/ai-settings/queries"
import { ApiClientError } from "@sendcms/shared"

import {
  Badge,
  Button,
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
import { CopyField } from "../../domains/copy-field"
import { DomainStatusBadge } from "../../domains/domain-status-badge"
import { FieldsSection } from "./fields-section"
import { InstallSnippet } from "@/components/dashboard/install-snippet"
import { useTranslation } from "@/components/dashboard/translation-provider"
import { buildEmbedSnippet } from "@sendcms/sdk/snippet"

function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border p-4 sm:p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{description}</p>
      {children}
    </section>
  )
}

/** Digest timestamps arrive as Dates from the server render and as
    ISO strings after a client refetch — normalize either way. */
function formatDigestDate(value: Date | string): string {
  return format(new Date(value), "PPpp")
}

export function FormDetail({
  initialForm,
  appUrl,
  turnstileSiteKey,
}: {
  initialForm: FormDetailResponse
  appUrl: string
  /** Public Turnstile site key (NEXT_PUBLIC_TURNSTILE_SITE_KEY) — null
      when unset. Only used for the embed snippet. */
  turnstileSiteKey: string | null
}) {
  const { t } = useTranslation("forms")
  const router = useRouter()
  const { data } = useForm(initialForm.id, initialForm)
  const form = data ?? initialForm
  const updateForm = useUpdateForm(form.id)
  const deleteForm = useDeleteForm(form.id)

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
  const [deleteError, setDeleteError] = useState<string | null>(null)

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

  async function onToggleActive(active: boolean) {
    setSettingsError(null)
    try {
      await updateForm.mutateAsync({ active })
    } catch (err) {
      setSettingsError(
        err instanceof ApiClientError ? err.message : t("statusFailed")
      )
    }
  }

  async function onDelete() {
    const submissions = form._count.submissions
    if (!confirm(t("confirmDelete", { name: form.name, submissions }))) return
    setDeleteError(null)
    try {
      await deleteForm.mutateAsync(form.name)
      router.push("/dashboard/forms")
    } catch (err) {
      setDeleteError(
        err instanceof ApiClientError ? err.message : t("deleteFailed")
      )
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">{form.name}</h2>
          <Badge variant={form.active ? "default" : "secondary"}>
            {form.active ? t("statusActive") : t("statusPaused")}
          </Badge>
          <span className="ml-auto flex items-center gap-2">
            <Label htmlFor="active-toggle">{t("acceptingSubmissions")}</Label>
            <Switch
              id="active-toggle"
              checked={form.active}
              onCheckedChange={onToggleActive}
              disabled={updateForm.isPending}
            />
          </span>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <CopyField
            label={t("publicUserId")}
            value={form.ownerId}
            description={t("publicUserIdDescription")}
            domain="forms"
          />
          <CopyField
            label={t("publicFormId")}
            value={form.id}
            description={t("publicFormIdDescription")}
            domain="forms"
          />
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          {t("countsLine", {
            submissions: form._count.submissions,
            fields: form.fields.length,
            domains: form.domainLinks.length,
          })}
        </p>
      </section>

      <Section
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
              <Label htmlFor="settings-daily-limit">
                {t("dailyLimitLabel")}
              </Label>
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
            <Label htmlFor="settings-description">
              {t("descriptionLabel")}
            </Label>
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
            <p
              role="alert"
              className="rounded-lg border border-amber-500/50 bg-amber-50 p-4 text-sm text-amber-900"
            >
              {t("turnstileServerMissing")}
            </p>
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
      </Section>

      <Section title={t("fieldsTitle")} description={t("fieldsDescription")}>
        <FieldsSection form={form} />
      </Section>

      <Section title={t("embedTitle")} description={t("embedDescription")}>
        {/* DSH-102: the snippet is shown even when the form cannot
            receive submissions — say so plainly, above the snippet. */}
        {getFormEmbedWarnings(form).map((warning) => (
          <p
            key={warning}
            role="alert"
            className="mb-3 rounded-lg border border-amber-500/50 bg-amber-50 p-4 text-sm text-amber-900"
          >
            {t(
              warning === "no-domain"
                ? "embedNoDomainWarning"
                : "embedPausedWarning"
            )}
          </p>
        ))}
        {form.turnstileEnabled && !turnstileSiteKey ? (
          // No site key, no working snippet: without
          // data-turnstile-site-key the SDK sends no token and the
          // server rejects every submission with 422 — so show the
          // warning instead of a snippet that looks ready to paste.
          <p
            role="alert"
            className="rounded-lg border border-amber-500/50 bg-amber-50 p-4 text-sm text-amber-900"
          >
            {t("embedTurnstileKeyMissing")}
          </p>
        ) : (
          <>
            <InstallSnippet
              code={buildEmbedSnippet(appUrl, form, turnstileSiteKey)}
              domain="forms"
            />
            <p className="mt-3 text-sm text-muted-foreground">
              {t("embedPlainIntro")}{" "}
              <code className="font-mono text-xs">{"<form>"}</code>{" "}
              {t("embedPlainPosting")}{" "}
              <code className="font-mono text-xs">{`${appUrl}/api/public/v1/submit`}</code>{" "}
              {t("embedPlainSuffix")}
            </p>
          </>
        )}
      </Section>

      <DomainsSection form={form} />
      <NotificationsSection form={form} />

      <section className="rounded-lg border border-destructive/50 p-4 sm:p-6">
        <h2 className="text-base font-semibold text-destructive">
          {t("deleteFormTitle")}
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("deleteFormDescription", {
            submissions: form._count.submissions,
          })}
        </p>
        {deleteError && (
          <p role="alert" className="mb-4 text-sm text-destructive">
            {deleteError}
          </p>
        )}
        <Button
          variant="destructive"
          onClick={onDelete}
          disabled={deleteForm.isPending}
        >
          {deleteForm.isPending ? t("deleting") : t("deleteForm")}
        </Button>
      </section>
    </div>
  )
}

function DomainsSection({ form }: { form: FormDetail }) {
  const { t } = useTranslation("forms")
  const { data: domains = [] } = useDomains()
  const linkDomain = useLinkDomain(form.id)
  const [selected, setSelected] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [unlinkError, setUnlinkError] = useState<string | null>(null)

  const linkedIds = new Set(form.domainLinks.map((l) => l.domainId))
  const linkable = domains.filter(
    (d) => d.status === "VERIFIED" && !linkedIds.has(d.id)
  )

  async function onLink() {
    if (!selected) return
    setError(null)
    try {
      await linkDomain.mutateAsync({ domainId: selected })
      setSelected("")
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("linkFailed"))
    }
  }

  return (
    <Section title={t("domainsTitle")} description={t("domainsDescription")}>
      {form.domainLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noDomainsLinked")}</p>
      ) : (
        <ul className="mb-4 flex flex-col gap-2">
          {form.domainLinks.map((link) => (
            <li
              key={link.id}
              className="flex items-center gap-3 rounded-lg border px-4 py-3"
            >
              <span className="font-medium">{link.domain.domain}</span>
              <DomainStatusBadge status={link.domain.status} domain="forms" />
              <span className="ml-auto">
                <UnlinkButton
                  formId={form.id}
                  domainId={link.domainId}
                  domainName={link.domain.domain}
                  onError={setUnlinkError}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      {unlinkError && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {unlinkError}
        </p>
      )}
      {linkable.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-2">
            <Label htmlFor="link-domain">{t("linkDomainLabel")}</Label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger id="link-domain" className="w-64">
                <SelectValue placeholder={t("linkDomainPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {linkable.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.domain}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={onLink} disabled={!selected || linkDomain.isPending}>
            {linkDomain.isPending ? t("linking") : t("linkDomain")}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("noLinkablePrefix")}{" "}
          <Link href="/dashboard/domains" className="underline">
            {t("domainsLink")}
          </Link>
          {t("noLinkableSuffix")}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      )}
    </Section>
  )
}

function UnlinkButton({
  formId,
  domainId,
  domainName,
  onError,
}: {
  formId: string
  domainId: string
  domainName: string
  onError: (msg: string | null) => void
}) {
  const { t } = useTranslation("forms")
  const unlink = useUnlinkDomain(formId, domainId)
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={unlink.isPending}
      onClick={async () => {
        if (!confirm(t("confirmUnlink", { domain: domainName }))) return
        onError(null)
        try {
          await unlink.mutateAsync()
        } catch (err) {
          onError(
            err instanceof ApiClientError ? err.message : t("unlinkFailed")
          )
        }
      }}
    >
      {t("unlink")}
    </Button>
  )
}

function NotificationsSection({ form }: { form: FormDetail }) {
  const { t } = useTranslation("forms")
  const addEmail = useAddNotificationEmail(form.id)
  const [email, setEmail] = useState("")
  const [error, setError] = useState<string | null>(null)

  async function onAdd(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await addEmail.mutateAsync({ email })
      setEmail("")
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : t("addRecipientFailed")
      )
    }
  }

  return (
    <Section
      title={t("notificationsTitle")}
      description={t("notificationsDescription")}
    >
      {form.notificationSettings.length === 0 ? (
        <p className="mb-4 text-sm text-muted-foreground">
          {t("noRecipients")}
        </p>
      ) : (
        <ul className="mb-4 flex flex-col gap-2">
          {form.notificationSettings.map((row) => (
            <li
              key={row.id}
              className="flex items-center gap-3 rounded-lg border px-4 py-3"
            >
              <span className="font-medium">{row.email}</span>
              <Badge variant={row.enabled ? "default" : "secondary"}>
                {row.enabled ? t("recipientOn") : t("recipientOff")}
              </Badge>
              {/* EML-096: verification state is visible both ways —
                  the unconfirmed badge existed; a confirmed recipient
                  now shows Verified instead of nothing. */}
              {row.confirmed === false ? (
                <Badge variant="outline">{t("recipientUnconfirmed")}</Badge>
              ) : (
                <Badge variant="outline">{t("recipientVerified")}</Badge>
              )}
              <span className="ml-auto flex items-center gap-2">
                {row.confirmed === false && (
                  <NotificationResendButton formId={form.id} rowId={row.id} />
                )}
                <NotificationToggle
                  formId={form.id}
                  rowId={row.id}
                  enabled={row.enabled}
                />
                <NotificationDeleteButton
                  formId={form.id}
                  rowId={row.id}
                  email={row.email}
                  onError={setError}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={onAdd} className="flex flex-wrap items-end gap-2">
        <div className="space-y-2">
          <Label htmlFor="notification-email">{t("addRecipientLabel")}</Label>
          <Input
            id="notification-email"
            type="email"
            autoComplete="off"
            placeholder="owner@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <Button type="submit" disabled={addEmail.isPending}>
          {addEmail.isPending ? t("adding") : t("addRecipient")}
        </Button>
      </form>
      <TestEmailForm formId={form.id} />
      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      )}
    </Section>
  )
}

function TestEmailForm({ formId }: { formId: string }) {
  const { t } = useTranslation("forms")
  const sendTest = useSendTestEmail(formId)
  const [to, setTo] = useState("")
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onSend(e: React.FormEvent) {
    e.preventDefault()
    setMessage(null)
    setError(null)
    try {
      const result = await sendTest.mutateAsync(to)
      setMessage(
        t("testEmailSent", {
          provider: result.provider,
          messageId: result.messageId,
        })
      )
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : t("testEmailFailed")
      )
    }
  }

  return (
    <form
      onSubmit={onSend}
      className="mt-6 flex flex-wrap items-end gap-2 border-t pt-4"
    >
      <div className="space-y-2">
        <Label htmlFor="test-email">{t("testEmailLabel")}</Label>
        <Input
          id="test-email"
          type="email"
          autoComplete="off"
          placeholder="you@example.com"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          required
        />
      </div>
      <Button type="submit" variant="outline" disabled={sendTest.isPending}>
        {sendTest.isPending ? t("sending") : t("sendTestEmail")}
      </Button>
      {message && (
        <p role="status" className="w-full text-sm text-green-700">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}

function NotificationResendButton({
  formId,
  rowId,
}: {
  formId: string
  rowId: string
}) {
  const { t } = useTranslation("forms")
  const resend = useResendNotificationConfirmation(formId, rowId)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <span className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={resend.isPending}
        onClick={async () => {
          setError(null)
          setSent(false)
          try {
            await resend.mutateAsync()
            setSent(true)
          } catch (err) {
            setError(
              err instanceof ApiClientError
                ? err.message
                : t("resendConfirmationFailed")
            )
          }
        }}
      >
        {resend.isPending
          ? t("sending")
          : sent
            ? t("resendConfirmationSent")
            : t("resendConfirmation")}
      </Button>
      {error && <span className="text-sm text-destructive">{error}</span>}
    </span>
  )
}

function NotificationToggle({
  formId,
  rowId,
  enabled,
}: {
  formId: string
  rowId: string
  enabled: boolean
}) {
  const { t } = useTranslation("forms")
  const update = useUpdateNotificationEmail(formId, rowId)
  return (
    <Switch
      checked={enabled}
      onCheckedChange={(v) => update.mutate({ enabled: v })}
      disabled={update.isPending}
      aria-label={t("toggleNotifications")}
    />
  )
}

function NotificationDeleteButton({
  formId,
  rowId,
  email,
  onError,
}: {
  formId: string
  rowId: string
  email: string
  onError: (msg: string | null) => void
}) {
  const { t } = useTranslation("forms")
  const remove = useDeleteNotificationEmail(formId, rowId)
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={remove.isPending}
      onClick={async () => {
        if (!confirm(t("confirmRemoveRecipient", { email }))) return
        onError(null)
        try {
          await remove.mutateAsync()
        } catch (err) {
          onError(
            err instanceof ApiClientError
              ? err.message
              : t("removeRecipientFailed")
          )
        }
      }}
    >
      {t("removeRecipient")}
    </Button>
  )
}
