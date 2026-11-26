"use client"

import { useState } from "react"
import {
  useAddNotificationEmail,
  useDeleteNotificationEmail,
  useResendNotificationConfirmation,
  useUpdateNotificationEmail,
} from "@sendcms/forms/queries"
import type { FormDetail } from "@sendcms/forms/queries"
import { useSendTestEmail } from "@sendcms/notifications/queries"
import { ApiClientError } from "@sendcms/shared"

import { Badge, Button, Input, Label, Switch } from "@sendcms/ui"

import { useTranslation } from "@/components/dashboard/translation-provider"
import { FormSection } from "./form-section"

// The notification-recipients section (Wave 10, SRC-118: split out of
// form-detail.tsx by concern). Owns the add/toggle/resend/delete and
// test-email state.
export function FormNotificationsSection({ form }: { form: FormDetail }) {
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
    <FormSection
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
    </FormSection>
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
        <p role="status" className="w-full text-sm text-success">
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
