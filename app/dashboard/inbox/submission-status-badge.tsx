import { Badge } from "@/components/ui/badge"
import type { SubmissionStatus } from "@/generated/prisma/client"

const STATUS_BADGE: Record<
  SubmissionStatus,
  {
    label: string
    variant: "default" | "secondary" | "destructive" | "outline"
    className?: string
  }
> = {
  NEW: { label: "Unread", variant: "default" },
  READ: { label: "Read", variant: "secondary" },
  STARRED: {
    label: "Starred",
    variant: "outline",
    className:
      "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-400",
  },
  ARCHIVED: { label: "Archived", variant: "outline" },
  SPAM: { label: "Spam", variant: "destructive" },
}

export function SubmissionStatusBadge({
  status,
}: {
  status: SubmissionStatus
}) {
  const badge = STATUS_BADGE[status]
  return (
    <Badge variant={badge.variant} className={badge.className}>
      {badge.label}
    </Badge>
  )
}
