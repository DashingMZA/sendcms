"use client"

import Link from "next/link"
import { useDomains } from "@sendcms/domains/queries"
import type { DomainWithVerification } from "@sendcms/domains/queries"

import { DomainStatusBadge } from "./domain-status-badge"
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sendcms/ui"

import { RiAddLine, RiGlobalLine } from "@remixicon/react"
import { useTranslation } from "@/components/dashboard/translation-provider"

function formatDate(value: string | Date | null) {
  if (!value) return "—"
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

export function DomainsTable({
  initialDomains,
}: {
  initialDomains: DomainWithVerification[]
}) {
  const { t } = useTranslation("domains")
  const { data: domains = initialDomains } = useDomains(initialDomains)

  // "DNS TXT" is the technical method name and stays as-is.
  const METHOD_LABEL: Record<string, string> = {
    DNS_TXT: "DNS TXT",
    META_TAG: t("methodMetaTagShort"),
    FILE: t("methodFileShort"),
  }

  if (domains.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-20 text-center">
        <RiGlobalLine
          className="mb-4 size-10 text-muted-foreground"
          aria-hidden="true"
        />
        <h3 className="mb-1 text-lg font-semibold text-balance">
          {t("emptyTitle")}
        </h3>
        <p className="mb-4 max-w-sm text-sm text-muted-foreground">
          {t("emptyDescription")}
        </p>
        <Button asChild size="sm">
          <Link href="/dashboard/domains/new">
            <RiAddLine className="size-4" aria-hidden="true" />
            {t("addDomain")}
          </Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("colDomain")}</TableHead>
            <TableHead>{t("colStatus")}</TableHead>
            <TableHead>{t("colMethod")}</TableHead>
            <TableHead>{t("colVerified")}</TableHead>
            <TableHead>{t("colForms")}</TableHead>
            <TableHead>{t("colAdded")}</TableHead>
            <TableHead className="w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {domains.map((domain) => {
            const verification = domain.verifications[0]
            return (
              <TableRow key={domain.id}>
                <TableCell className="font-medium">{domain.domain}</TableCell>
                <TableCell>
                  <DomainStatusBadge status={domain.status} />
                </TableCell>
                <TableCell>
                  {verification ? METHOD_LABEL[verification.method] : "—"}
                </TableCell>
                <TableCell>{formatDate(domain.verifiedAt)}</TableCell>
                <TableCell>{domain._count.formLinks}</TableCell>
                <TableCell>{formatDate(domain.createdAt)}</TableCell>
                <TableCell>
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`/dashboard/domains/${domain.id}`}>
                      {t("view")}
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
