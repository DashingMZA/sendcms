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

import { Download } from "lucide-react"
import type { DomainVerificationMethod } from "@sendcms/database"

const METHOD_LABEL: Record<DomainVerificationMethod, string> = {
  DNS_TXT: "DNS TXT record",
  META_TAG: "HTML meta tag",
  FILE: "Verification file",
}

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
  challenge: string
): VerificationInstructions {
  switch (method) {
    case "DNS_TXT":
      return {
        kind: "dns",
        title: "Add this TXT record",
        body: `Add a TXT record to ${domain} at your DNS provider. It usually propagates within a few minutes.`,
        name: `sendcms._domainkey.${domain}`,
        value: challenge,
      }
    case "META_TAG":
      return {
        kind: "snippet",
        title: "Add this meta tag",
        body: `Add this tag inside the <head> of https://${domain}/.`,
        code: `<meta name="sendcms-verification" content="${challenge}">`,
        language: "html",
      }
    case "FILE":
      return {
        kind: "file",
        title: "Publish this file",
        body: `Upload a file named sendcms-verification.txt to your site's public folder — the same place ads.txt goes — so it is reachable at the URL below. Its entire content must be the code shown.`,
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

  async function onVerify() {
    setError(null)
    setCheck(null)
    try {
      const result = await verify.mutateAsync()
      setCheck(result)
      if (result.verified) router.refresh()
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Verification failed."
      )
    }
  }

  async function onReverify() {
    setError(null)
    setCheck(null)
    try {
      await reverify.mutateAsync({ method })
      router.refresh()
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not switch the verification method."
      )
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
    if (
      !confirm(`Suspend ${domain.domain}? It will stop accepting submissions.`)
    )
      return
    try {
      await setStatus.mutateAsync({ action: "suspend" })
      router.refresh()
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Could not suspend."
      )
    }
  }

  async function onReactivate() {
    try {
      await setStatus.mutateAsync({ action: "reactivate" })
      router.refresh()
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Could not reactivate."
      )
    }
  }

  async function onDelete() {
    if (
      !confirm(
        `Delete ${domain.domain}? Its verification history is removed too. Forms linked to it must be unlinked first.`
      )
    )
      return
    try {
      await remove.mutateAsync()
      router.push("/dashboard/domains")
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Could not delete."
      )
    }
  }

  const instructions = verification
    ? verificationInstructions(
        domain.domain,
        verification.method,
        verification.challenge
      )
    : null

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <CardTitle className="text-step-1">{domain.domain}</CardTitle>
            <DomainStatusBadge status={domain.status} />
          </div>
          <CardDescription>
            Added{" "}
            {new Date(domain.createdAt).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
            {domain.verifiedAt
              ? ` · Verified ${new Date(domain.verifiedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`
              : ""}
            {` · ${domain._count.formLinks} linked form(s)`}
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
                <CopyField label="Record name" value={instructions.name} />
                <CopyField label="Record value" value={instructions.value} />
              </>
            )}
            {instructions.kind === "snippet" && (
              <InstallSnippet
                code={instructions.code}
                language={instructions.language}
              />
            )}
            {instructions.kind === "file" && (
              <>
                <p className="rounded-lg border bg-muted/50 px-4 py-3 font-mono text-sm break-all">
                  {instructions.url}
                </p>
                <CopyField label="File content" value={instructions.value} />
                <div>
                  <Button variant="outline" onClick={downloadVerificationFile}>
                    <Download className="size-4" aria-hidden="true" />
                    Download sendcms-verification.txt
                  </Button>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Download the file and upload it as-is — no editing needed.
                  </p>
                </div>
              </>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={onVerify} disabled={verify.isPending}>
                {verify.isPending ? "Checking…" : "Check verification"}
              </Button>
              <span className="text-sm text-muted-foreground">
                {verification.attempts > 0
                  ? `${verification.attempts} failed check(s) — ${10 - verification.attempts} remaining before a new challenge is needed.`
                  : "Challenge expires 7 days after it was issued."}
              </span>
            </div>
            {check && !check.verified && (
              <p role="alert" className="text-sm text-destructive">
                {check.reason}
              </p>
            )}
            {check && check.verified && (
              <p className="text-success text-sm">
                Verified — this domain can now receive submissions.
              </p>
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
                  <SelectItem value="DNS_TXT">DNS TXT record</SelectItem>
                  <SelectItem value="META_TAG">HTML meta tag</SelectItem>
                  <SelectItem value="FILE">Verification file</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                onClick={onReverify}
                disabled={reverify.isPending || method === verification.method}
              >
                {reverify.isPending ? "Switching…" : "Switch method"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Switches to the selected method — the verification value stays
                the same.
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {domain.status === "VERIFIED" && (
        <Card>
          <CardHeader>
            <CardTitle>Verified</CardTitle>
            <CardDescription>
              This domain can receive form submissions. Only verified domains
              are accepted by the submission API.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={onSuspend}
              disabled={setStatus.isPending}
            >
              Suspend domain
            </Button>
          </CardContent>
        </Card>
      )}

      {domain.status === "SUSPENDED" && (
        <Card>
          <CardHeader>
            <CardTitle>Suspended</CardTitle>
            <CardDescription>
              This domain is not accepting submissions. Reactivate it to resume
              — it keeps its verified status.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={onReactivate} disabled={setStatus.isPending}>
              Reactivate domain
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Method</CardTitle>
          <CardDescription>
            {verification
              ? `Current method: ${METHOD_LABEL[verification.method]}.`
              : "No pending verification."}
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
              Delete domain
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              Deleting removes the domain and its verification history. A domain
              linked to forms cannot be deleted until it is unlinked.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
