"use client"

import Link from "next/link"
import { useState } from "react"
import { useDomains } from "@sendcms/domains/queries"
import { useLinkDomain, useUnlinkDomain } from "@sendcms/forms/queries"
import type { FormDetail } from "@sendcms/forms/queries"
import { ApiClientError } from "@sendcms/shared"

import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sendcms/ui"

import { DomainStatusBadge } from "../../domains/domain-status-badge"
import { useTranslation } from "@/components/dashboard/translation-provider"
import { FormSection } from "./form-section"

// The linked-domains section (Wave 10, SRC-118: split out of
// form-detail.tsx by concern). Owns the link/unlink state.
export function FormDomainsSection({ form }: { form: FormDetail }) {
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
    <FormSection
      title={t("domainsTitle")}
      description={t("domainsDescription")}
    >
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
    </FormSection>
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
