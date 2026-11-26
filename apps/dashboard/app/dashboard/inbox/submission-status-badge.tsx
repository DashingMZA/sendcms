import { Badge } from "@sendcms/ui"

import type { SubmissionStatus } from "@sendcms/database"

/**
 * Translation key (in the caller's domain: "inbox", "overview" or
 * "analytics") for each submission status's display label. The badge
 * itself stays a server component and takes the already-translated
 * label — the enum value is data and is never rendered.
 */
export const SUBMISSION_STATUS_LABEL_KEYS: Record<SubmissionStatus, string> = {
  NEW: "statusNew",
  READ: "statusRead",
  STARRED: "statusStarred",
  ARCHIVED: "statusArchived",
  SPAM: "statusSpam",
}

const STATUS_BADGE: Record<
  SubmissionStatus,
  {
    variant: "default" | "secondary" | "destructive" | "outline"
    className?: string
  }
> = {
  NEW: { variant: "default" },
  READ: { variant: "secondary" },
  STARRED: {
    variant: "outline",
    className: "border-warning/40 bg-warning/10 text-warning-foreground",
  },
  ARCHIVED: { variant: "outline" },
  SPAM: { variant: "destructive" },
}

export function SubmissionStatusBadge({
  status,
  label,
}: {
  status: SubmissionStatus
  label: string
}) {
  const badge = STATUS_BADGE[status]
  return (
    <Badge variant={badge.variant} className={badge.className}>
      {label}
    </Badge>
  )
}
