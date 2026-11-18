import { Badge } from "@sendcms/ui"

import type { DomainStatus } from "@/generated/prisma/client"

const STATUS_BADGE: Record<
  DomainStatus,
  { variant: "default" | "secondary" | "destructive"; label: string }
> = {
  PENDING: { variant: "secondary", label: "Pending" },
  VERIFIED: { variant: "default", label: "Verified" },
  SUSPENDED: { variant: "destructive", label: "Suspended" },
}

export function DomainStatusBadge({ status }: { status: DomainStatus }) {
  const { variant, label } = STATUS_BADGE[status]
  return <Badge variant={variant}>{label}</Badge>
}
