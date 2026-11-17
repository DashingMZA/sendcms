"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  useDeleteDomain,
  useReverifyDomain,
  useSetDomainStatus,
  useVerifyDomain,
} from "@/lib/queries/domains"
import type { DomainDetail } from "@/lib/queries/domains"
import { ApiClientError } from "@/lib/api-client"
import { DomainStatusBadge } from "../domain-status-badge"
import { InstallSnippet } from "@/components/dashboard/install-snippet"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { DomainVerificationMethod } from "@/generated/prisma/client"

const METHOD_LABEL: Record<DomainVerificationMethod, string> = {
  DNS_TXT: "DNS TXT record",
  META_TAG: "HTML meta tag",
  FILE: "Verification file",
}

function verificationInstructions(
  domain: string,
  method: DomainVerificationMethod,
  challenge: string
): { title: string; body: string; code: string; language: string } {
  switch (method) {
    case "DNS_TXT":
      return {
        title: "Add this TXT record",
        body: `Add a TXT record to ${domain} at your DNS provider. It usually propagates within a few minutes.`,
        code: `_contact-verify.${domain}  TXT  ${challenge}`,
        language: "dns",
      }
    case "META_TAG":
      return {
        title: "Add this meta tag",
        body: `Add this tag inside the <head> of https://${domain}/.`,
        code: `<meta name="sendcms-verification" content="${challenge}">`,
        language: "html",
      }
    case "FILE":
      return {
        title: "Publish this file",
        body: `Serve a file at this URL whose entire content is the challenge below.`,
        code: `https://${domain}/.well-known/sendcms-verification.txt\n\n${challenge}`,
        language: "text",
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
          : "Could not start a new verification."
      )
    }
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
            <InstallSnippet
              code={instructions.code}
              language={instructions.language}
            />
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
                disabled={reverify.isPending}
              >
                {reverify.isPending ? "Issuing…" : "Start a new verification"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Issues a fresh challenge with the selected method.
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
