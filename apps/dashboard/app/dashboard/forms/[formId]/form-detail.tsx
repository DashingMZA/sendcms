"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useDeleteForm, useForm, useUpdateForm } from "@sendcms/forms/queries"
import type { FormDetailResponse } from "@sendcms/forms/queries"
import { getFormEmbedWarnings } from "@sendcms/forms/queries"
import { ApiClientError } from "@sendcms/shared"

import {
  Badge,
  Button,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Label,
  Switch,
} from "@sendcms/ui"

import { CopyField } from "../../domains/copy-field"
import { FieldsSection } from "./fields-section"
import { FormDomainsSection } from "./form-domains-section"
import { FormNotificationsSection } from "./form-notifications-section"
import { FormSection } from "./form-section"
import { FormSettingsSection } from "./form-settings-section"
import { InstallSnippet } from "@/components/dashboard/install-snippet"
import { useTranslation } from "@/components/dashboard/translation-provider"
import { buildEmbedSnippet } from "@sendcms/sdk/snippet"

// The form-detail page shell (Wave 10, SRC-118): header card +
// embed + danger zone + composition. Settings, domains, and
// notifications live in their own files by concern; the Embed section
// stays here — the Wave 6 tests pin its warning strings to this file.
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

  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)

  async function onToggleActive(active: boolean) {
    setToggleError(null)
    try {
      await updateForm.mutateAsync({ active })
    } catch (err) {
      setToggleError(
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
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="text-lg font-semibold">{form.name}</CardTitle>
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
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
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
          {toggleError && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {toggleError}
            </p>
          )}
        </CardContent>
      </Card>

      <FormSettingsSection form={form} />

      <FormSection
        title={t("fieldsTitle")}
        description={t("fieldsDescription")}
      >
        <FieldsSection form={form} />
      </FormSection>

      <FormSection title={t("embedTitle")} description={t("embedDescription")}>
        {/* DSH-102: the snippet is shown even when the form cannot
            receive submissions — say so plainly, above the snippet. */}
        {getFormEmbedWarnings(form).map((warning) => (
          <Callout key={warning} role="alert" className="mb-3">
            {t(
              warning === "no-domain"
                ? "embedNoDomainWarning"
                : "embedPausedWarning"
            )}
          </Callout>
        ))}
        {form.turnstileEnabled && !turnstileSiteKey ? (
          // No site key, no working snippet: without
          // data-turnstile-site-key the SDK sends no token and the
          // server rejects every submission with 422 — so show the
          // warning instead of a snippet that looks ready to paste.
          <Callout role="alert">{t("embedTurnstileKeyMissing")}</Callout>
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
      </FormSection>

      <FormDomainsSection form={form} />
      <FormNotificationsSection form={form} />

      <FormSection
        tone="destructive"
        title={t("deleteFormTitle")}
        description={t("deleteFormDescription", {
          submissions: form._count.submissions,
        })}
      >
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
      </FormSection>
    </div>
  )
}
