"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useCreateDomain } from "@sendcms/domains/queries"
import { ApiClientError } from "@sendcms/shared"

import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sendcms/ui"

import type { DomainVerificationMethod } from "@sendcms/database"
import { useTranslation } from "@/components/dashboard/translation-provider"

export function AddDomainForm() {
  const { t } = useTranslation("domains")
  const router = useRouter()
  const createDomain = useCreateDomain()
  const [domain, setDomain] = useState("")
  const [method, setMethod] = useState<DomainVerificationMethod>("DNS_TXT")
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const created = await createDomain.mutateAsync({ domain, method })
      router.push(`/dashboard/domains/${created.id}`)
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("addFailed"))
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-lg space-y-6">
      <div className="space-y-2">
        <Label htmlFor="domain">{t("domainLabel")}</Label>
        <Input
          id="domain"
          type="text"
          autoComplete="off"
          placeholder="example.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          required
        />
        <p className="text-xs text-muted-foreground">{t("domainHint")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="method">{t("methodLabel")}</Label>
        <Select
          value={method}
          onValueChange={(v) => setMethod(v as DomainVerificationMethod)}
        >
          <SelectTrigger id="method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="DNS_TXT">
              {t("methodDnsTxtRecommended")}
            </SelectItem>
            <SelectItem value="META_TAG">{t("methodMetaTag")}</SelectItem>
            <SelectItem value="FILE">{t("methodFile")}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t("methodHint")}</p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" disabled={createDomain.isPending}>
        {createDomain.isPending ? t("adding") : t("addDomain")}
      </Button>
    </form>
  )
}
