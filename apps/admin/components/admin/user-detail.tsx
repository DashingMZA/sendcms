// User detail shell (Wave 10, SRC-118 split): the page header (shared
// PageHeader, UX-005/UX-008), the tab shell, the action state and the
// confirm/step-up dialogs. Each tab lives in its own file under
// ./user-detail/ — profile, forms, domains, submissions, package, ai,
// mcp (+ keys card), audit. The shell owns every mutation; tabs only
// render and call back into `openAction` / `onExport`.
"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import {
  useAdminUser,
  useApproveUser,
  useDisableUser,
  useExportUserData,
  useReactivateUser,
  useRejectUser,
  useRequestDeletion,
  useRequireEmailVerification,
  useRestoreUser,
  useRevokeUserApiKeys,
  useRevokeUserSessions,
  useSetAdminRole,
  useSuspendUser,
  useTriggerPasswordReset,
  type AdminUserDetail,
} from "@sendcms/admin-users/queries"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"
import { PageHeader } from "./page-header"
import { StepUpDialog } from "./step-up-dialog"
import { UserAiTab } from "./user-ai-tab"
import { UserMcpTab } from "./user-mcp-tab"
import { UserPackageTab } from "./user-package-tab"
import { UserRoleBadge, UserStatusBadge } from "./user-status-badge"
import { UserActionDialog } from "./user-detail/user-action-dialog"
import { UserAuditTab } from "./user-detail/user-audit-tab"
import { UserDomainsTab } from "./user-detail/user-domains-tab"
import { UserFormsTab } from "./user-detail/user-forms-tab"
import { UserMcpKeysCard } from "./user-detail/user-mcp-keys-card"
import { UserProfileTab } from "./user-detail/user-profile-tab"
import { UserSubmissionsTab } from "./user-detail/user-submissions-tab"
import type { UserDetailActionKind } from "./user-detail/shared"
import type { AiBillingMode } from "@sendcms/database"
import type { UserMcpSettingsRow } from "@sendcms/mcp-admin"

/** Download a JSON object as a file (admin user-data export). */
function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

type Props = {
  initialData: AdminUserDetail
  userId: string
  actorId: string
  actorRole: PlatformRole | AdminRole
  aiBillingMode: AiBillingMode
  mcpSettings: UserMcpSettingsRow | null
  mcpToolNames: readonly string[]
}

export function UserDetail({
  initialData,
  userId,
  actorId,
  actorRole,
  aiBillingMode,
  mcpSettings,
  mcpToolNames,
}: Props) {
  const { t } = useTranslation("users")
  const [tab, setTab] = useState("profile")
  const [action, setAction] = useState<UserDetailActionKind | null>(null)
  const [reason, setReason] = useState("")
  const [roleValue, setRoleValue] = useState<string>("none")
  // Step-up (Phase 9): the password dialog for disable + role change.
  const [stepUpOpen, setStepUpOpen] = useState(false)

  const { data } = useAdminUser(userId, initialData)
  const detail = data ?? initialData
  const profile = detail.profile

  const suspend = useSuspendUser(userId)
  const reactivate = useReactivateUser(userId)
  const disable = useDisableUser(userId)
  const restore = useRestoreUser(userId)
  // DOC-003: approval queue actions (Stream B hooks, plan §5.7 — POST
  // to the approve/reject routes, invalidate onSettled).
  const approve = useApproveUser(userId)
  const rejectUser = useRejectUser(userId)
  const setRole = useSetAdminRole(userId)
  const revokeKeys = useRevokeUserApiKeys(userId)
  const revokeSessions = useRevokeUserSessions(userId)
  const requireVerification = useRequireEmailVerification(userId)
  const passwordReset = useTriggerPasswordReset(userId)
  const requestDeletion = useRequestDeletion(userId)
  const exportUser = useExportUserData(userId)

  // Capability gates (UX only — the service enforces them server-side).
  const canManage = adminCan(actorRole, "MANAGE_USERS")
  const canViewSensitive = adminCan(actorRole, "VIEW_SENSITIVE_SUBMISSIONS")
  const canExport = adminCan(actorRole, "VIEW_CUSTOMER_DATA")
  const isOwnerTarget = profile.platformRole === "PLATFORM_OWNER"
  const isSelf = profile.id === actorId
  // Role changes are owner/Super Admin only — MANAGER holds MANAGE_USERS
  // but may not change roles, and never for the owner or yourself.
  const canChangeRole =
    canManage && actorRole !== "MANAGER" && !isOwnerTarget && !isSelf
  const canSuspend = canManage && !isOwnerTarget && !isSelf
  // DOC-003: approve/reject need MANAGE_USERS plus the same owner/self
  // guards as suspend — a pending PLATFORM_OWNER cannot exist (§5.1),
  // but the guard stays for symmetry. No step-up (D10): approval is
  // reversible via suspend, rejection via restore.
  const canApproveReject = canSuspend
  const canRevokeSessions = canManage && !isSelf

  function openAction(kind: UserDetailActionKind) {
    setReason("")
    setRoleValue(profile.adminRole ?? "none")
    setAction(kind)
  }

  const confirmPending =
    (action === "suspend" && suspend.isPending) ||
    (action === "reactivate" && reactivate.isPending) ||
    (action === "disable" && disable.isPending) ||
    (action === "restore" && restore.isPending) ||
    (action === "approve" && approve.isPending) ||
    (action === "reject" && rejectUser.isPending) ||
    (action === "role" && setRole.isPending) ||
    (action === "revokeKeys" && revokeKeys.isPending) ||
    (action === "revokeSessions" && revokeSessions.isPending) ||
    (action === "requireVerification" && requireVerification.isPending) ||
    (action === "passwordReset" && passwordReset.isPending) ||
    (action === "requestDeletion" && requestDeletion.isPending)

  const reasonRequired =
    action === "suspend" ||
    action === "disable" ||
    action === "reject" ||
    action === "requestDeletion"
  const confirmDisabled =
    confirmPending || (reasonRequired && reason.trim() === "")

  // Step-up (Phase 9): disable + role change need a password
  // re-entry first. The confirm dialog stays open behind the
  // step-up dialog; onVerified runs the same confirmAction.
  function handleConfirmClick() {
    if (action === "disable" || action === "role") {
      setStepUpOpen(true)
      return
    }
    void confirmAction()
  }

  async function confirmAction() {
    if (!action) return
    try {
      switch (action) {
        case "suspend":
          await suspend.mutateAsync({ reason: reason.trim() })
          toast.success(t("toastSuspended"))
          break
        case "reactivate":
          await reactivate.mutateAsync(
            reason.trim() ? { reason: reason.trim() } : {}
          )
          toast.success(t("toastReactivated"))
          break
        case "disable":
          await disable.mutateAsync({ reason: reason.trim() })
          toast.success(t("toastDisabled"))
          break
        case "restore":
          await restore.mutateAsync(
            reason.trim() ? { reason: reason.trim() } : {}
          )
          toast.success(t("toastRestored"))
          break
        case "approve":
          await approve.mutateAsync(
            reason.trim() ? { reason: reason.trim() } : {}
          )
          toast.success(t("toastApproved"))
          break
        case "reject":
          await rejectUser.mutateAsync({ reason: reason.trim() })
          toast.success(t("toastRejected"))
          break
        case "role":
          await setRole.mutateAsync({
            adminRole: roleValue === "none" ? null : (roleValue as AdminRole),
          })
          toast.success(t("toastRoleChanged"))
          break
        case "revokeKeys": {
          const result = await revokeKeys.mutateAsync()
          toast.success(t("toastKeysRevoked", { count: result.count }))
          break
        }
        case "revokeSessions": {
          const result = await revokeSessions.mutateAsync()
          toast.success(t("toastSessionsRevoked", { count: result.count }))
          break
        }
        case "requireVerification":
          await requireVerification.mutateAsync()
          toast.success(t("toastVerificationRequired"))
          break
        case "passwordReset":
          await passwordReset.mutateAsync()
          toast.success(t("toastPasswordResetSent"))
          break
        case "requestDeletion":
          await requestDeletion.mutateAsync({ reason: reason.trim() })
          toast.success(t("toastDeletionRequested"))
          break
      }
      setAction(null)
      setReason("")
    } catch {
      // The query provider's global mutation error toast already shows
      // the failure — the dialog stays open so the admin can retry.
    }
  }

  async function exportData() {
    try {
      const data = await exportUser.mutateAsync()
      downloadJson(data, `sendcms-user-${userId}.json`)
      toast.success(t("toastExported"))
    } catch {
      // Global mutation error toast already shown.
    }
  }

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
    <div>
      <PageHeader
        title={profile.name}
        description={<bdi dir="ltr">{profile.email}</bdi>}
        back={{ href: "/admin/all-users", label: t("backToUsers") }}
        action={
          <div className="flex items-center gap-2">
            <UserStatusBadge status={profile.status} labels={statusLabels} />
            <UserRoleBadge role={profile.adminRole} labels={roleLabels} />
          </div>
        }
      />
      <div tabIndex={-1} className="flex flex-col gap-6 p-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="h-auto flex-wrap justify-start">
            <TabsTrigger value="profile">{t("tabProfile")}</TabsTrigger>
            <TabsTrigger value="forms">{t("tabForms")}</TabsTrigger>
            <TabsTrigger value="domains">{t("tabDomains")}</TabsTrigger>
            <TabsTrigger value="submissions">{t("tabSubmissions")}</TabsTrigger>
            <TabsTrigger value="package">{t("tabPackage")}</TabsTrigger>
            <TabsTrigger value="ai">{t("tabAi")}</TabsTrigger>
            <TabsTrigger value="mcp">{t("tabMcp")}</TabsTrigger>
            <TabsTrigger value="audit">{t("tabAudit")}</TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="mt-6">
            <UserProfileTab
              detail={detail}
              canSuspend={canSuspend}
              canManage={canManage}
              canApproveReject={canApproveReject}
              canChangeRole={canChangeRole}
              canRevokeSessions={canRevokeSessions}
              canExport={canExport}
              exportPending={exportUser.isPending}
              onAction={openAction}
              onExport={exportData}
            />
          </TabsContent>

          <TabsContent value="forms" className="mt-6">
            <UserFormsTab forms={detail.forms} />
          </TabsContent>

          <TabsContent value="domains" className="mt-6">
            <UserDomainsTab domains={detail.domains} />
          </TabsContent>

          <TabsContent value="submissions" className="mt-6">
            <UserSubmissionsTab userId={userId} canReveal={canViewSensitive} />
          </TabsContent>

          <TabsContent value="package" className="mt-6">
            <UserPackageTab
              userId={userId}
              userName={profile.name}
              userEmail={profile.email}
              actorRole={actorRole}
            />
          </TabsContent>

          <TabsContent value="ai" className="mt-6">
            <UserAiTab
              userId={userId}
              userName={profile.name}
              userEmail={profile.email}
              actorRole={actorRole}
              initialBillingMode={aiBillingMode}
            />
          </TabsContent>

          <TabsContent value="mcp" className="mt-6">
            <div className="flex flex-col gap-6">
              <UserMcpTab
                userId={userId}
                actorRole={actorRole}
                initialSettings={mcpSettings}
                toolNames={mcpToolNames}
              />
              <UserMcpKeysCard
                apiKeys={detail.apiKeys}
                canManage={canManage}
                onRevokeKeys={() => openAction("revokeKeys")}
              />
            </div>
          </TabsContent>

          <TabsContent value="audit" className="mt-6">
            <UserAuditTab
              userId={userId}
              auditEvents={detail.auditEvents}
              notes={detail.notes}
              canManage={canManage}
            />
          </TabsContent>
        </Tabs>

        <UserActionDialog
          action={action}
          reason={reason}
          roleValue={roleValue}
          confirmDisabled={confirmDisabled}
          onReasonChange={setReason}
          onRoleChange={setRoleValue}
          onClose={() => {
            setAction(null)
            setReason("")
          }}
          onConfirm={handleConfirmClick}
        />
        <StepUpDialog
          open={stepUpOpen}
          onOpenChange={setStepUpOpen}
          onVerified={() => void confirmAction()}
        />
      </div>
    </div>
  )
}
