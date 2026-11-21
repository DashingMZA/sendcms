import { Badge } from "@sendcms/ui"

/**
 * Status chip for a user account: ACTIVE / SUSPENDED / DISABLED.
 * Shared by the users list and the user detail page. The labels come
 * from the caller (already translated) so this stays a plain server
 * component.
 */
export function UserStatusBadge({
  status,
  labels,
}: {
  status: "ACTIVE" | "SUSPENDED" | "DISABLED"
  labels: { active: string; suspended: string; disabled: string }
}) {
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
