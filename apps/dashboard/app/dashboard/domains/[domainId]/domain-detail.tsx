"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  useDeleteDomain,
  useReverifyDomain,
  useSetDomainStatus,
  useVerifyDomain,
} from "@sendcms/domains/queries"
import type { DomainDetail } from "@sendcms/domains/queries"
import { ApiClientError } from "@sendcms/shared"

import { DomainStatusBadge } from "../domain-status-badge"
import { CopyField } from "../copy-field"
import { InstallSnippet } from "@/components/dashboard/install-snippet"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sendcms/ui"

import { RiDownloadLine } from "@remixicon/react"
import type { DomainVerificationMethod } from "@sendcms/database"
import { formatDate } from "@sendcms/i18n"
import {
  useLocale,
  useTranslation,
} from "@/components/dashboard/translation-provider"

type Translate = (key: string, vars?: Record<string, string | number>) => string

type DnsInstructions = {
  kind: "dns"
  title: string
  body: string
  name: string
  value: string
}

type SnippetInstructions = {
  kind: "snippet"
  title: string
  body: string
  code: string
  language: string
}

type FileInstructions = {
  kind: "file"
  title: string
  body: string
  url: string
  value: string
}

type VerificationInstructions =
  DnsInstructions | SnippetInstructions | FileInstructions

function verificationInstructions(
  domain: string,
  method: DomainVerificationMethod,
  challenge: string,
  t: Translate
): VerificationInstructions {
  switch (method) {
    case "DNS_TXT":
      return {
        kind: "dns",
        title: t("dnsTitle"),
        body: t("dnsBody", { domain }),
        name: `sendcms._domainkey.${domain}`,
        value: challenge,
      }
    case "META_TAG":
      return {
        kind: "snippet",
        title: t("metaTitle"),
        body: t("metaBody", { domain }),
        code: `<meta name="sendcms-verification" content="${challenge}">`,
        language: "html",
      }
    case "FILE":
      return {
        kind: "file",
        title: t("fileTitle"),
        body: t("fileBody"),
        url: `https://${domain}/sendcms-verification.txt`,
        value: challenge,
      }
  }
}

export function DomainDetail({
  initialDomain,
}: {
  initialDomain: DomainDetail
}) {
  const { t } = useTranslation("domains")
  const locale = useLocale()
  const router = useRouter()
  const domain = initialDomain
  const verification = domain.verifications.find((v) => v.status === "PENDING")
  const verify = useVerifyDomain(domain.id)
  const reverify = useReverifyDomain(domain.id)
  const setStatus = useSetDomainStatus(domain.id)
  const remove = useDeleteDomain(domain.id)
  const [method, setMethod] = useState<DomainVerificationMethod>(
    verification?.method ?? "DNS_TXT"
  )
  const [prevMethod, setPrevMethod] = useState<
    DomainVerificationMethod | undefined
  >(verification?.method)
  // Adjust state during render (not in an effect): the select follows the
  // server's current method after a switch, because the component keeps
  // its own state across refreshes.
  if (prevMethod !== verification?.method) {
    setPrevMethod(verification?.method)
    setMethod(verification?.method ?? "DNS_TXT")
  }
  const [check, setCheck] = useState<{
    verified: boolean
    reason?: string
    attempts: number
    maxAttempts: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const METHOD_LABEL: Record<DomainVerificationMethod, string> = {
    DNS_TXT: t("methodDnsTxtRecord"),
    META_TAG: t("methodMetaTag"),
    FILE: t("methodFile"),
  }

  async function onVerify() {
    setError(null)
    setCheck(null)
    try {
      const result = await verify.mutateAsync()
      setCheck(result)
      // DSH-103: refresh after EVERY verify result, not only on
      // success — a failed check increments the attempt count
      // server-side, and this component reads `initialDomain`
      // directly, so without the refresh "attempts remaining" stays
      // at the pre-attempt count until manual navigation.
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("verifyFailed"))
    }
  }

  async function onReverify() {
    setError(null)
    setCheck(null)
    try {
      await reverify.mutateAsync({ method })
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("switchFailed"))
    }
  }

  // Download the verification file (sendcms-verification.txt) so it can
  // be uploaded to the site's public folder as-is.
  function downloadVerificationFile() {
    if (!verification) return
    const blob = new Blob([verification.challenge], {
      type: "text/plain",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "sendcms-verification.txt"
    a.click()
    URL.revokeObjectURL(url)
  }

  async function onSuspend() {
    if (!confirm(t("confirmSuspend", { domain: domain.domain }))) return
    try {
      await setStatus.mutateAsync({ action: "suspend" })
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("suspendFailed"))
    }
  }

  async function onReactivate() {
    try {
      await setStatus.mutateAsync({ action: "reactivate" })
      router.refresh()
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : t("reactivateFailed")
      )
    }
  }

  async function onDelete() {
    if (!confirm(t("confirmDelete", { domain: domain.domain }))) return
    try {
      await remove.mutateAsync(domain.domain)
      router.push("/dashboard/domains")
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("deleteFailed"))
    }
  }

  const instructions = verification
    ? verificationInstructions(
        domain.domain,
        verification.method,
        verification.challenge,
        t
      )
    : null

  const addedDate = domain.createdAt
    ? formatDate(locale, domain.createdAt, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null
  const verifiedDate = domain.verifiedAt
    ? formatDate(locale, domain.verifiedAt, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <CardTitle>{domain.domain}</CardTitle>
            <DomainStatusBadge status={domain.status} />
          </div>
          <CardDescription>
            {addedDate ? t("addedOn", { date: addedDate }) : ""}
            {verifiedDate
              ? ` · ${t("verifiedOn", { date: verifiedDate })}`
              : ""}
            {` · ${t("linkedForms", { count: domain._count.formLinks })}`}
          </CardDescription>
        </CardHeader>
      </Card>

      {domain.status === "PENDING" && instructions && verification && (
        <Card>
          <CardHeader>
            <CardTitle>{instructions.title}</CardTitle>
            <CardDescription>{instructions.body}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {instructions.kind === "dns" && (
              <>
                <CopyField
                  label={t("recordName")}
                  value={instructions.name}
                  domain="domains"
                />
                <CopyField
                  label={t("recordValue")}
                  value={instructions.value}
                  domain="domains"
                />
              </>
            )}
            {instructions.kind === "snippet" && (
              <InstallSnippet
                code={instructions.code}
                language={instructions.language}
                domain="domains"
              />
            )}
            {instructions.kind === "file" && (
              <>
                <p className="rounded-lg border bg-muted/50 px-4 py-3 font-mono text-sm break-all">
                  {instructions.url}
                </p>
                <CopyField
                  label={t("fileContent")}
                  value={instructions.value}
                  domain="domains"
                />
                <div>
                  <Button variant="outline" onClick={downloadVerificationFile}>
                    <RiDownloadLine className="size-4" aria-hidden="true" />
                    {t("downloadFile")}
                  </Button>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("downloadHint")}
                  </p>
                </div>
              </>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={onVerify} disabled={verify.isPending}>
                {verify.isPending ? t("checking") : t("checkVerification")}
              </Button>
              <span className="text-sm text-muted-foreground">
                {verification.attempts > 0
                  ? t("attemptsRemaining", {
                      failed: verification.attempts,
                      remaining: 10 - verification.attempts,
                    })
                  : t("challengeExpiry")}
              </span>
            </div>
            {check && !check.verified && (
              <p role="alert" className="text-sm text-destructive">
                {check.reason}
              </p>
            )}
            {check && check.verified && (
              <p className="text-sm text-success">{t("verifiedMessage")}</p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
              <Select
                value={method}
                onValueChange={(v) => setMethod(v as DomainVerificationMethod)}
              >
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DNS_TXT">
                    {METHOD_LABEL.DNS_TXT}
                  </SelectItem>
                  <SelectItem value="META_TAG">
                    {METHOD_LABEL.META_TAG}
                  </SelectItem>
                  <SelectItem value="FILE">{METHOD_LABEL.FILE}</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                onClick={onReverify}
                disabled={reverify.isPending || method === verification.method}
              >
                {reverify.isPending ? t("switching") : t("switchMethod")}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t("switchHint")}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {domain.status === "VERIFIED" && (
        <Card>
          <CardHeader>
            <CardTitle>{t("verifiedTitle")}</CardTitle>
            <CardDescription>{t("verifiedDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={onSuspend}
              disabled={setStatus.isPending}
            >
              {t("suspendDomain")}
            </Button>
          </CardContent>
        </Card>
      )}

      {domain.status === "SUSPENDED" && (
        <Card>
          <CardHeader>
            <CardTitle>{t("suspendedTitle")}</CardTitle>
            <CardDescription>{t("suspendedDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={onReactivate} disabled={setStatus.isPending}>
              {t("reactivateDomain")}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("methodTitle")}</CardTitle>
          <CardDescription>
            {verification
              ? t("methodCurrent", {
                  method: METHOD_LABEL[verification.method],
                })
              : t("methodNone")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error && domain.status !== "PENDING" && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div>
            <Button
              variant="destructive"
              onClick={onDelete}
              disabled={remove.isPending}
            >
              {t("deleteDomain")}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("deleteDescription")}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
