"use client"

import Link from "next/link"
import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  useDeleteForm,
  useForm,
  useLinkDomain,
  useUnlinkDomain,
  useUpdateForm,
  useAddNotificationEmail,
  useUpdateNotificationEmail,
  useDeleteNotificationEmail,
} from "@/lib/queries/forms"
import { useDomains } from "@/lib/queries/domains"
import type { FormDetail } from "@/lib/queries/forms"
import { ApiClientError } from "@/lib/api-client"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CopyField } from "../../domains/copy-field"
import { DomainStatusBadge } from "../../domains/domain-status-badge"
import { FieldsSection } from "./fields-section"

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

export function FormDetail({ initialForm }: { initialForm: FormDetail }) {
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
      })
    } catch (err) {
      setSettingsError(
        err instanceof ApiClientError
          ? err.message
          : "Could not save these settings."
      )
    }
  }

  async function onToggleActive(active: boolean) {
    setSettingsError(null)
    try {
      await updateForm.mutateAsync({ active })
    } catch (err) {
      setSettingsError(
        err instanceof ApiClientError
          ? err.message
          : "Could not change the form status."
      )
    }
  }

  async function onDelete() {
    const submissions = form._count.submissions
    if (
      !confirm(
        `Delete "${form.name}"? This also deletes its ${submissions} submission(s). This cannot be undone.`
      )
    )
      return
    setDeleteError(null)
    try {
      await deleteForm.mutateAsync()
      router.push("/dashboard/forms")
    } catch (err) {
      setDeleteError(
        err instanceof ApiClientError
          ? err.message
          : "Could not delete this form."
      )
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">{form.name}</h2>
          <Badge variant={form.active ? "default" : "secondary"}>
            {form.active ? "Active" : "Paused"}
          </Badge>
          <span className="ml-auto flex items-center gap-2">
            <Label htmlFor="active-toggle">Accepting submissions</Label>
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
            label="Public user ID"
            value={form.ownerId}
            description="Your public identifier — used with the form ID by the SDK and REST API."
          />
          <CopyField
            label="Public form ID"
            value={form.id}
            description="This form's public identifier."
          />
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          {form._count.submissions} submission(s) · {form.fields.length}{" "}
          field(s) · {form.domainLinks.length} linked domain(s)
        </p>
      </section>

      <Section
        title="Settings"
        description="Name, messages, redirect and spam protection for this form"
      >
        <form onSubmit={onSaveSettings} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="settings-name">Form name</Label>
              <Input
                id="settings-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-daily-limit">
                Daily submission limit
              </Label>
              <Input
                id="settings-daily-limit"
                type="number"
                min={1}
                max={100000}
                placeholder="Unlimited"
                value={dailyLimit}
                onChange={(e) => setDailyLimit(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-description">Description</Label>
            <Textarea
              id="settings-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-success">Success message</Label>
            <Input
              id="settings-success"
              autoComplete="off"
              placeholder="Thanks! We'll get back to you soon."
              value={successMessage}
              onChange={(e) => setSuccessMessage(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-redirect">Redirect URL</Label>
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
              <Label htmlFor="settings-honeypot">Honeypot spam trap</Label>
              <p className="text-xs text-muted-foreground">
                An invisible field bots fill in and humans never see.
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
              <Label htmlFor="settings-turnstile">Cloudflare Turnstile</Label>
              <p className="text-xs text-muted-foreground">
                Extra bot protection on the submission form (keys configured in
                Phase 5).
              </p>
            </div>
            <Switch
              id="settings-turnstile"
              checked={turnstileEnabled}
              onCheckedChange={setTurnstileEnabled}
            />
          </div>
          {settingsError && (
            <p role="alert" className="text-sm text-destructive">
              {settingsError}
            </p>
          )}
          <div>
            <Button type="submit" disabled={updateForm.isPending}>
              {updateForm.isPending ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </form>
      </Section>

      <Section
        title="Fields"
        description="The fields visitors fill in. The key is what arrives in the submission payload."
      >
        <FieldsSection form={form} />
      </Section>

      <DomainsSection form={form} />
      <NotificationsSection form={form} />

      <section className="rounded-lg border border-destructive/50 p-4 sm:p-6">
        <h2 className="text-base font-semibold text-destructive">
          Delete form
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Permanently deletes this form, its fields, domain links and{" "}
          {form._count.submissions} submission(s). This cannot be undone.
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
          {deleteForm.isPending ? "Deleting…" : "Delete form"}
        </Button>
      </section>
    </div>
  )
}

function DomainsSection({ form }: { form: FormDetail }) {
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
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not link this domain."
      )
    }
  }

  return (
    <Section
      title="Allowed domains"
      description="This form only accepts submissions from the verified domains linked here. One form can serve many domains; one domain can serve many forms."
    >
      {form.domainLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No domains linked yet. Link a verified domain below — until then this
          form accepts submissions from nowhere.
        </p>
      ) : (
        <ul className="mb-4 flex flex-col gap-2">
          {form.domainLinks.map((link) => (
            <li
              key={link.id}
              className="flex items-center gap-3 rounded-lg border px-4 py-3"
            >
              <span className="font-medium">{link.domain.domain}</span>
              <DomainStatusBadge status={link.domain.status} />
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
            <Label htmlFor="link-domain">Link a verified domain</Label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger id="link-domain" className="w-64">
                <SelectValue placeholder="Choose a domain" />
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
            {linkDomain.isPending ? "Linking…" : "Link domain"}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No verified domains available to link. Verify a domain first from{" "}
          <Link href="/dashboard/domains" className="underline">
            Domains
          </Link>
          .
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
  const unlink = useUnlinkDomain(formId, domainId)
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={unlink.isPending}
      onClick={async () => {
        if (
          !confirm(
            `Unlink ${domainName}? Submissions from it will be rejected.`
          )
        )
          return
        onError(null)
        try {
          await unlink.mutateAsync()
        } catch (err) {
          onError(
            err instanceof ApiClientError
              ? err.message
              : "Could not unlink this domain."
          )
        }
      }}
    >
      Unlink
    </Button>
  )
}

function NotificationsSection({ form }: { form: FormDetail }) {
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
        err instanceof ApiClientError
          ? err.message
          : "Could not add this recipient."
      )
    }
  }

  return (
    <Section
      title="Notification recipients"
      description="Each new submission is emailed to these addresses (Phase 8). One row per recipient — toggling one never touches the others."
    >
      {form.notificationSettings.length === 0 ? (
        <p className="mb-4 text-sm text-muted-foreground">No recipients yet.</p>
      ) : (
        <ul className="mb-4 flex flex-col gap-2">
          {form.notificationSettings.map((row) => (
            <li
              key={row.id}
              className="flex items-center gap-3 rounded-lg border px-4 py-3"
            >
              <span className="font-medium">{row.email}</span>
              <Badge variant={row.enabled ? "default" : "secondary"}>
                {row.enabled ? "On" : "Off"}
              </Badge>
              <span className="ml-auto flex items-center gap-2">
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
          <Label htmlFor="notification-email">Add recipient</Label>
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
          {addEmail.isPending ? "Adding…" : "Add recipient"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      )}
    </Section>
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
  const update = useUpdateNotificationEmail(formId, rowId)
  return (
    <Switch
      checked={enabled}
      onCheckedChange={(v) => update.mutate({ enabled: v })}
      disabled={update.isPending}
      aria-label="Toggle notifications for this recipient"
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
  const remove = useDeleteNotificationEmail(formId, rowId)
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={remove.isPending}
      onClick={async () => {
        if (!confirm(`Remove ${email} from notifications?`)) return
        onError(null)
        try {
          await remove.mutateAsync()
        } catch (err) {
          onError(
            err instanceof ApiClientError
              ? err.message
              : "Could not remove this recipient."
          )
        }
      }}
    >
      Remove
    </Button>
  )
}
