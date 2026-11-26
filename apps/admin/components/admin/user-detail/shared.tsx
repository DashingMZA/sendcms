// Shared bits for the user-detail tabs (Wave 10, SRC-118 split of
// user-detail.tsx): the confirm-action kinds, one profile field row,
// and the dashed empty-state box used by every tab.
"use client"

export type UserDetailActionKind =
  | "suspend"
  | "reactivate"
  | "disable"
  | "restore"
  | "role"
  | "revokeKeys"
  | "revokeSessions"
  | "requireVerification"
  | "passwordReset"
  | "requestDeletion"

/** One profile field row (label + value). */
export function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  )
}

/** Dashed empty-state box (same pattern as the dashboard tables). */
export function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
      {icon}
      <h3 className="mb-1 text-lg font-semibold text-balance">{title}</h3>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
  )
}
