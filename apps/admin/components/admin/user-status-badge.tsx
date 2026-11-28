import { Badge } from "@sendcms/ui"

/**
 * Status chip for a user account: ACTIVE / PENDING_APPROVAL /
 * SUSPENDED / DISABLED. Shared by the users list and the user detail
 * page. The labels come from the caller (already translated) so this
 * stays a plain server component. PENDING_APPROVAL uses `outline` —
 * the Badge API exposes no warning variant (DOC-003).
 */
export function UserStatusBadge({
  status,
  labels,
}: {
  status: "ACTIVE" | "PENDING_APPROVAL" | "SUSPENDED" | "DISABLED"
  labels: {
    active: string
    pending: string
    suspended: string
    disabled: string
  }
}) {
  if (status === "PENDING_APPROVAL") {
    return <Badge variant="outline">{labels.pending}</Badge>
  }
  if (status === "SUSPENDED") {
    return <Badge variant="destructive">{labels.suspended}</Badge>
  }
  if (status === "DISABLED") {
    return <Badge variant="outline">{labels.disabled}</Badge>
  }
  return <Badge variant="secondary">{labels.active}</Badge>
}

export function UserRoleBadge({
  role,
  labels,
}: {
  role: "SUPER_ADMIN" | "MANAGER" | "SUPPORT" | null
  labels: {
    superAdmin: string
    manager: string
    support: string
    none: string
  }
}) {
  if (role === null) {
    return <span className="text-sm text-muted-foreground">{labels.none}</span>
  }
  const label =
    role === "SUPER_ADMIN"
      ? labels.superAdmin
      : role === "MANAGER"
        ? labels.manager
        : labels.support
  return <Badge variant="secondary">{label}</Badge>
}
