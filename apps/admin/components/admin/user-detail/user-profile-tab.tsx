// User-detail "Profile" tab (Wave 10, SRC-118 split of user-detail.tsx):
// the profile fields card + the actions card. Action buttons only
// open the confirm dialog — the shell owns the mutations.
"use client"

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sendcms/ui"
import type { AdminUserDetail } from "@sendcms/admin-users/queries"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDateTime } from "../plan-format"
import { UserRoleBadge, UserStatusBadge } from "../user-status-badge"
import { Field, type UserDetailActionKind } from "./shared"

type Props = {
  detail: AdminUserDetail
  canSuspend: boolean
  canManage: boolean
  canApproveReject: boolean
  canChangeRole: boolean
  canRevokeSessions: boolean
  canExport: boolean
  exportPending: boolean
  onAction: (kind: UserDetailActionKind) => void
  onExport: () => void
}

export function UserProfileTab({
  detail,
  canSuspend,
  canManage,
  canApproveReject,
  canChangeRole,
  canRevokeSessions,
  canExport,
  exportPending,
  onAction,
  onExport,
}: Props) {
  const { t } = useTranslation("users")
  const locale = useLocale()
  const profile = detail.profile

  const statusLabels = {
    active: t("statusActive"),
    pending: t("statusPendingApproval"),
    suspended: t("statusSuspended"),
    disabled: t("statusDisabled"),
  }
  const roleLabels = {
    superAdmin: t("roleSuperAdmin"),
    manager: t("roleManager"),
    support: t("roleSupport"),
    none: t("roleNone"),
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("profileTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <Field label={t("name")}>{profile.name}</Field>
            <Field label={t("email")}>
              <bdi dir="ltr">{profile.email}</bdi>
            </Field>
            <Field label={t("emailVerified")}>
              {profile.emailVerified ? t("verifiedYes") : t("verifiedNo")}
            </Field>
            <Field label={t("platformRole")}>
              <Badge variant="secondary">
                {profile.platformRole === "PLATFORM_OWNER"
                  ? t("platformOwner")
                  : t("platformUser")}
              </Badge>
            </Field>
            <Field label={t("adminRole")}>
              <UserRoleBadge role={profile.adminRole} labels={roleLabels} />
            </Field>
            <Field label={t("status")}>
              <span className="flex flex-wrap items-center gap-2">
                <UserStatusBadge
                  status={profile.status}
                  labels={statusLabels}
                />
                {profile.statusReason && (
                  <span className="font-normal text-muted-foreground">
                    {profile.statusReason}
                  </span>
                )}
              </span>
            </Field>
            <Field label={t("statusChangedAt")}>
              {formatDateTime(locale, profile.statusChangedAt)}
            </Field>
            <Field label={t("locale")}>
              {profile.locale ?? t("localeNone")}
            </Field>
            <Field label={t("createdAt")}>
              {formatDateTime(locale, profile.createdAt)}
            </Field>
            <Field label={t("updatedAt")}>
              {formatDateTime(locale, profile.updatedAt)}
            </Field>
            <Field label={t("deletionRequested")}>
              {profile.deletionRequestedAt
                ? formatDateTime(locale, profile.deletionRequestedAt)
                : t("deletionRequestedNone")}
            </Field>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("actionsTitle")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {canSuspend && profile.status === "ACTIVE" && (
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => onAction("suspend")}
            >
              {t("suspend")}
            </Button>
          )}
          {canManage && profile.status === "SUSPENDED" && (
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => onAction("reactivate")}
            >
              {t("reactivate")}
            </Button>
          )}
          {canSuspend && profile.status === "ACTIVE" && (
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => onAction("disable")}
            >
              {t("disable")}
            </Button>
          )}
          {canManage && profile.status === "DISABLED" && (
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => onAction("restore")}
            >
              {t("restore")}
            </Button>
          )}
          {/* DOC-003: approval queue actions — detail page only (Q9),
              shown only while the account awaits approval. */}
          {canApproveReject && profile.status === "PENDING_APPROVAL" && (
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => onAction("approve")}
            >
              {t("approve")}
            </Button>
          )}
          {canApproveReject && profile.status === "PENDING_APPROVAL" && (
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => onAction("reject")}
            >
              {t("reject")}
            </Button>
          )}
          {canChangeRole && (
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => onAction("role")}
            >
              {t("changeRole")}
            </Button>
          )}
          {canManage && (
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => onAction("revokeKeys")}
            >
              {t("revokeKeys")}
            </Button>
          )}
          {canRevokeSessions && (
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => onAction("revokeSessions")}
            >
              {t("revokeSessions")}
            </Button>
          )}
          {canManage && (
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => onAction("requireVerification")}
            >
              {t("requireVerification")}
            </Button>
          )}
          {canManage && (
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => onAction("passwordReset")}
            >
              {t("passwordReset")}
            </Button>
          )}
          {canManage && (
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => onAction("requestDeletion")}
            >
              {t("requestDeletion")}
            </Button>
          )}
          {canExport && (
            <Button
              variant="outline"
              className="justify-start"
              onClick={onExport}
              disabled={exportPending}
            >
              {t("exportData")}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
