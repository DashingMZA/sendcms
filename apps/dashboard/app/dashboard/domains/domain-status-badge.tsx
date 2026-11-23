"use client"

import { Badge } from "@sendcms/ui"

import { useTranslation } from "@/components/dashboard/translation-provider"

import type { DomainStatus } from "@sendcms/database"

const STATUS_KEY: Record<DomainStatus, string> = {
  PENDING: "statusPending",
  VERIFIED: "statusVerified",
  SUSPENDED: "statusSuspended",
}

const STATUS_BADGE: Record<
  DomainStatus,
  { variant: "default" | "secondary" | "destructive" }
> = {
  PENDING: { variant: "secondary" },
  VERIFIED: { variant: "default" },
  SUSPENDED: { variant: "destructive" },
}

// The badge is shared by the domains pages and the form detail, and
// each page only loads its own domain — the `domain` prop selects
// which dictionary the status label comes from.
export function DomainStatusBadge({
  status,
  domain = "domains",
}: {
  status: DomainStatus
  domain?: string
}) {
  const { t } = useTranslation(domain)
  const { variant } = STATUS_BADGE[status]
  return <Badge variant={variant}>{t(STATUS_KEY[status])}</Badge>
}
