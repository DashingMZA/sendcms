"use client"

import { useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import {
  useAddAdminNote,
  useAdminUser,
  useAdminUserSubmission,
  useAdminUserSubmissions,
  useDisableUser,
  useExportUserData,
  useReactivateUser,
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
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@sendcms/ui"
import {
  RiArrowLeftLine,
  RiEyeLine,
  RiFileTextLine,
  RiInformationLine,
  RiKeyLine,
  RiStickyNoteLine,
} from "@remixicon/react"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDate, formatDateTime } from "./plan-format"
import { StepUpDialog } from "./step-up-dialog"
import { UserAiTab } from "./user-ai-tab"
import { UserMcpTab } from "./user-mcp-tab"
import { UserPackageTab } from "./user-package-tab"
import { UserRoleBadge, UserStatusBadge } from "./user-status-badge"
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

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean")
    return String(value)
  return JSON.stringify(value)
}

type ActionKind =
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
  const locale = useLocale()
  const [tab, setTab] = useState("profile")
  const [action, setAction] = useState<ActionKind | null>(null)
  const [reason, setReason] = useState("")
  const [roleValue, setRoleValue] = useState<string>("none")
  const [noteBody, setNoteBody] = useState("")
  // Step-up (Phase 9): the password dialog for disable + role change.
  const [stepUpOpen, setStepUpOpen] = useState(false)

  const { data } = useAdminUser(userId, initialData)
  const detail = data ?? initialData
  const profile = detail.profile

  const suspend = useSuspendUser(userId)
  const reactivate = useReactivateUser(userId)
  const disable = useDisableUser(userId)
  const restore = useRestoreUser(userId)
  const setRole = useSetAdminRole(userId)
  const revokeKeys = useRevokeUserApiKeys(userId)
  const revokeSessions = useRevokeUserSessions(userId)
  const requireVerification = useRequireEmailVerification(userId)
  const passwordReset = useTriggerPasswordReset(userId)
  const requestDeletion = useRequestDeletion(userId)
  const exportUser = useExportUserData(userId)
  const addNote = useAddAdminNote(userId)

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
  const canRevokeSessions = canManage && !isSelf

  function openAction(kind: ActionKind) {
    setReason("")
    setRoleValue(profile.adminRole ?? "none")
    setAction(kind)
  }

  const confirmPending =
    (action === "suspend" && suspend.isPending) ||
    (action === "reactivate" && reactivate.isPending) ||
    (action === "disable" && disable.isPending) ||
    (action === "restore" && restore.isPending) ||
    (action === "role" && setRole.isPending) ||
    (action === "revokeKeys" && revokeKeys.isPending) ||
    (action === "revokeSessions" && revokeSessions.isPending) ||
    (action === "requireVerification" && requireVerification.isPending) ||
    (action === "passwordReset" && passwordReset.isPending) ||
    (action === "requestDeletion" && requestDeletion.isPending)

  const reasonRequired =
    action === "suspend" || action === "disable" || action === "requestDeletion"
  const reasonOptional = action === "reactivate" || action === "restore"
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

  async function submitNote(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!noteBody.trim()) return
    try {
      await addNote.mutateAsync({ body: noteBody.trim() })
      setNoteBody("")
      toast.success(t("toastNoteAdded"))
    } catch {
      // Global mutation error toast already shown.
    }
  }

  const dialogCopy: Record<
    ActionKind,
    {
      title: string
      description: string
      confirm: string
      destructive: boolean
    }
  > = {
    suspend: {
      title: t("suspendTitle"),
      description: t("suspendDescription"),
      confirm: t("confirmSuspend"),
      destructive: true,
    },
    reactivate: {
      title: t("reactivateTitle"),
      description: t("reactivateDescription"),
      confirm: t("confirmReactivate"),
      destructive: false,
    },
    disable: {
      title: t("disableTitle"),
      description: t("disableDescription"),
      confirm: t("confirmDisable"),
      destructive: true,
    },
    restore: {
      title: t("restoreTitle"),
      description: t("restoreDescription"),
      confirm: t("confirmRestore"),
      destructive: false,
    },
    role: {
      title: t("changeRoleTitle"),
      description: t("changeRoleDescription"),
      confirm: t("confirmChangeRole"),
      destructive: false,
    },
    revokeKeys: {
      title: t("revokeKeysTitle"),
      description: t("revokeKeysDescription"),
      confirm: t("confirmRevokeKeys"),
      destructive: true,
    },
    revokeSessions: {
      title: t("revokeSessionsTitle"),
      description: t("revokeSessionsDescription"),
      confirm: t("confirmRevokeSessions"),
      destructive: true,
    },
    requireVerification: {
      title: t("requireVerificationTitle"),
      description: t("requireVerificationDescription"),
      confirm: t("confirmRequireVerification"),
      destructive: false,
    },
    passwordReset: {
      title: t("passwordResetTitle"),
      description: t("passwordResetDescription"),
      confirm: t("confirmPasswordReset"),
      destructive: false,
    },
    requestDeletion: {
      title: t("requestDeletionTitle"),
      description: t("requestDeletionDescription"),
      confirm: t("confirmRequestDeletion"),
      destructive: true,
    },
  }

  const statusLabels = {
    active: t("statusActive"),
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
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
          <Link href="/admin/users">
            <RiArrowLeftLine className="size-4" aria-hidden="true" />
            {t("backToUsers")}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">{profile.name}</h1>
          <UserStatusBadge status={profile.status} labels={statusLabels} />
          <UserRoleBadge role={profile.adminRole} labels={roleLabels} />
        </div>
        <p className="text-muted-foreground">
          <bdi dir="ltr">{profile.email}</bdi>
        </p>
      </div>

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
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t("profileTitle")}</CardTitle>
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
                    <UserRoleBadge
                      role={profile.adminRole}
                      labels={roleLabels}
                    />
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
                <CardTitle>{t("actionsTitle")}</CardTitle>
                <CardDescription>{t("description")}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {canSuspend && profile.status === "ACTIVE" && (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() => openAction("suspend")}
                  >
                    {t("suspend")}
                  </Button>
                )}
                {canManage && profile.status === "SUSPENDED" && (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() => openAction("reactivate")}
                  >
                    {t("reactivate")}
                  </Button>
                )}
                {canSuspend && profile.status === "ACTIVE" && (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() => openAction("disable")}
                  >
                    {t("disable")}
                  </Button>
                )}
                {canManage && profile.status === "DISABLED" && (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() => openAction("restore")}
                  >
                    {t("restore")}
                  </Button>
                )}
                {canChangeRole && (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() => openAction("role")}
                  >
                    {t("changeRole")}
                  </Button>
                )}
                {canManage && (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() => openAction("revokeKeys")}
                  >
                    {t("revokeKeys")}
                  </Button>
                )}
                {canRevokeSessions && (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() => openAction("revokeSessions")}
                  >
                    {t("revokeSessions")}
                  </Button>
                )}
                {canManage && (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() => openAction("requireVerification")}
                  >
                    {t("requireVerification")}
                  </Button>
                )}
                {canManage && (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() => openAction("passwordReset")}
                  >
                    {t("passwordReset")}
                  </Button>
                )}
                {canManage && (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() => openAction("requestDeletion")}
                  >
                    {t("requestDeletion")}
                  </Button>
                )}
                {canExport && (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={exportData}
                    disabled={exportUser.isPending}
                  >
                    {t("exportData")}
                  </Button>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="forms" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("formsTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              {detail.forms.length === 0 ? (
                <EmptyState
                  icon={
                    <RiFileTextLine
                      className="mb-4 size-10 text-muted-foreground"
                      aria-hidden="true"
                    />
                  }
                  title={t("formsEmptyTitle")}
                  description={t("formsEmptyDescription")}
                />
              ) : (
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("formName")}</TableHead>
                        <TableHead>{t("formAi")}</TableHead>
                        <TableHead>{t("formCreated")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.forms.map((form) => (
                        <TableRow key={form.id}>
                          <TableCell className="font-medium">
                            {form.name}
                          </TableCell>
                          <TableCell>
                            {form.aiEnabled ? t("aiYes") : t("aiNo")}
                          </TableCell>
                          <TableCell>
                            {formatDate(locale, form.createdAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="domains" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("domainsTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              {detail.domains.length === 0 ? (
                <EmptyState
                  icon={
                    <RiInformationLine
                      className="mb-4 size-10 text-muted-foreground"
                      aria-hidden="true"
                    />
                  }
                  title={t("domainsEmptyTitle")}
                  description={t("domainsEmptyDescription")}
                />
              ) : (
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("domainName")}</TableHead>
                        <TableHead>{t("domainStatus")}</TableHead>
                        <TableHead>{t("domainCreated")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.domains.map((domain) => (
                        <TableRow key={domain.id}>
                          <TableCell className="font-medium">
                            {domain.domain}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">{domain.status}</Badge>
                          </TableCell>
                          <TableCell>
                            {formatDate(locale, domain.createdAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
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
            <Card>
              <CardHeader>
                <CardTitle>{t("mcpTitle")}</CardTitle>
                <CardDescription>{t("mcpNote")}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {canManage && detail.apiKeys.length > 0 && (
                  <div>
                    <Button
                      variant="outline"
                      onClick={() => openAction("revokeKeys")}
                    >
                      {t("revokeAllKeys")}
                    </Button>
                  </div>
                )}
                {detail.apiKeys.length === 0 ? (
                  <EmptyState
                    icon={
                      <RiKeyLine
                        className="mb-4 size-10 text-muted-foreground"
                        aria-hidden="true"
                      />
                    }
                    title={t("mcpEmptyTitle")}
                    description={t("mcpEmptyDescription")}
                  />
                ) : (
                  <div className="rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("keyName")}</TableHead>
                          <TableHead>{t("keyValue")}</TableHead>
                          <TableHead>{t("keyScope")}</TableHead>
                          <TableHead>{t("keyLastUsed")}</TableHead>
                          <TableHead>{t("keyCreated")}</TableHead>
                          <TableHead>{t("keyRevoked")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.apiKeys.map((key) => (
                          <TableRow key={key.id}>
                            <TableCell className="font-medium">
                              {key.name}
                            </TableCell>
                            <TableCell className="font-mono text-sm">
                              {key.prefix}…{key.last4}
                            </TableCell>
                            <TableCell>
                              <Badge variant="secondary">{key.scope}</Badge>
                            </TableCell>
                            <TableCell>
                              {formatDate(locale, key.lastUsedAt)}
                            </TableCell>
                            <TableCell>
                              {formatDate(locale, key.createdAt)}
                            </TableCell>
                            <TableCell>
                              {key.revokedAt ? (
                                <Badge variant="outline">
                                  {t("keyRevoked")}
                                </Badge>
                              ) : (
                                <Badge variant="secondary">
                                  {t("keyActive")}
                                </Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="audit" className="mt-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t("auditTitle")}</CardTitle>
              </CardHeader>
              <CardContent>
                {detail.auditEvents.length === 0 ? (
                  <EmptyState
                    icon={
                      <RiInformationLine
                        className="mb-4 size-10 text-muted-foreground"
                        aria-hidden="true"
                      />
                    }
                    title={t("auditEmptyTitle")}
                    description={t("auditEmptyDescription")}
                  />
                ) : (
                  <div className="rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("auditAction")}</TableHead>
                          <TableHead>{t("auditResource")}</TableHead>
                          <TableHead>{t("auditBy")}</TableHead>
                          <TableHead>{t("auditCreated")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.auditEvents.map((event) => (
                          <TableRow key={event.id}>
                            <TableCell>
                              <p className="font-medium">{event.action}</p>
                              <p className="max-w-64 truncate text-sm text-muted-foreground">
                                {event.detail == null
                                  ? "—"
                                  : JSON.stringify(event.detail)}
                              </p>
                            </TableCell>
                            <TableCell>
                              <p className="text-sm">{event.resourceType}</p>
                              <p className="font-mono text-xs text-muted-foreground">
                                {event.resourceId}
                              </p>
                            </TableCell>
                            <TableCell>
                              {event.user?.name ?? event.user?.email ?? "—"}
                            </TableCell>
                            <TableCell>
                              {formatDateTime(locale, event.createdAt)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t("notesTitle")}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {detail.notes.length === 0 ? (
                  <EmptyState
                    icon={
                      <RiStickyNoteLine
                        className="mb-4 size-10 text-muted-foreground"
                        aria-hidden="true"
                      />
                    }
                    title={t("notesEmptyTitle")}
                    description={t("notesEmptyDescription")}
                  />
                ) : (
                  <ul className="flex flex-col gap-4">
                    {detail.notes.map((note) => (
                      <li key={note.id} className="rounded-lg border p-4">
                        <p className="text-sm whitespace-pre-wrap">
                          {note.body}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {t("noteMeta", {
                            name: note.admin?.name ?? note.admin?.email ?? "—",
                            date: formatDateTime(locale, note.createdAt),
                          })}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {canManage && (
                  <form onSubmit={submitNote} className="flex flex-col gap-2">
                    <Label htmlFor="user-add-note">{t("addNoteLabel")}</Label>
                    <Textarea
                      id="user-add-note"
                      value={noteBody}
                      onChange={(e) => setNoteBody(e.target.value)}
                      placeholder={t("addNotePlaceholder")}
                      maxLength={2000}
                      rows={3}
                    />
                    <div>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={!noteBody.trim() || addNote.isPending}
                      >
                        {t("addNoteSubmit")}
                      </Button>
                    </div>
                  </form>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAction(null)
            setReason("")
          }
        }}
      >
        <DialogContent>
          {action && (
            <>
              <DialogHeader>
                <DialogTitle>{dialogCopy[action].title}</DialogTitle>
                <DialogDescription>
                  {dialogCopy[action].description}
                </DialogDescription>
              </DialogHeader>
              {action === "role" ? (
                <div className="space-y-1">
                  <Label htmlFor="user-role-select">{t("roleLabel")}</Label>
                  <Select value={roleValue} onValueChange={setRoleValue}>
                    <SelectTrigger id="user-role-select">
                      <SelectValue placeholder={t("roleLabel")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t("roleNone")}</SelectItem>
                      <SelectItem value="SUPER_ADMIN">
                        {t("roleSuperAdmin")}
                      </SelectItem>
                      <SelectItem value="MANAGER">
                        {t("roleManager")}
                      </SelectItem>
                      <SelectItem value="SUPPORT">
                        {t("roleSupport")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : reasonRequired || reasonOptional ? (
                <div className="space-y-1">
                  <Label htmlFor="user-action-reason">{t("reasonLabel")}</Label>
                  <Textarea
                    id="user-action-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={t("reasonPlaceholder")}
                    maxLength={500}
                    rows={3}
                  />
                  {reasonRequired && reason.trim() === "" && (
                    <p className="text-sm text-destructive">
                      {t("reasonRequired")}
                    </p>
                  )}
                </div>
              ) : null}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setAction(null)
                    setReason("")
                  }}
                >
                  {t("cancel")}
                </Button>
                <Button
                  variant={
                    dialogCopy[action].destructive ? "destructive" : "default"
                  }
                  onClick={handleConfirmClick}
                  disabled={confirmDisabled}
                >
                  {dialogCopy[action].confirm}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <StepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => void confirmAction()}
      />
    </main>
  )
}

/** One profile field row (label + value). */
function Field({
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
function EmptyState({
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

/**
 * Submissions tab: metadata table only — the submission `data` JSON is
 * never listed. Revealing one row loads the full content through the
 * getUserSubmission route, which logs the sensitive-access audit event.
 * The reveal button only exists for actors with
 * VIEW_SENSITIVE_SUBMISSIONS.
 */
function UserSubmissionsTab({
  userId,
  canReveal,
}: {
  userId: string
  canReveal: boolean
}) {
  const { t } = useTranslation("users")
  const locale = useLocale()
  const [page, setPage] = useState(1)
  const [revealId, setRevealId] = useState<string | null>(null)
  const { data } = useAdminUserSubmissions(userId, page)
  const submissions = data?.submissions ?? []
  const total = data?.total ?? 0
  const perPage = data?.perPage ?? 20
  const currentPage = data?.page ?? page
  const pageCount = Math.max(1, Math.ceil(total / perPage))
  const from = total === 0 ? 0 : (currentPage - 1) * perPage + 1
  const to = Math.min(total, currentPage * perPage)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("submissionsTitle")}</CardTitle>
        <CardDescription>{t("submissionsMaskedNote")}</CardDescription>
        {!canReveal && (
          <CardDescription>{t("submissionsNoReveal")}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {submissions.length === 0 ? (
          <EmptyState
            icon={
              <RiFileTextLine
                className="mb-4 size-10 text-muted-foreground"
                aria-hidden="true"
              />
            }
            title={t("submissionsEmptyTitle")}
            description={t("submissionsEmptyDescription")}
          />
        ) : (
          <>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("submissionForm")}</TableHead>
                    <TableHead>{t("submissionStatus")}</TableHead>
                    <TableHead>{t("submissionCreated")}</TableHead>
                    <TableHead>{t("submissionOrigin")}</TableHead>
                    {canReveal && <TableHead className="w-24" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {submissions.map((submission) => (
                    <TableRow key={submission.id}>
                      <TableCell className="font-medium">
                        {submission.formName}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{submission.status}</Badge>
                      </TableCell>
                      <TableCell>
                        {formatDate(locale, submission.createdAt)}
                      </TableCell>
                      <TableCell>{submission.originDomain}</TableCell>
                      {canReveal && (
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRevealId(submission.id)}
                          >
                            <RiEyeLine className="size-4" aria-hidden="true" />
                            {t("submissionReveal")}
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{t("showing", { from, to, total })}</span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  {t("previous")}
                </Button>
                <span className="self-center">
                  {t("pageOf", { page: currentPage, totalPages: pageCount })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage >= pageCount}
                  onClick={() => setPage(currentPage + 1)}
                >
                  {t("next")}
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
      {revealId !== null && (
        <SubmissionRevealDialog
          userId={userId}
          submissionId={revealId}
          onClose={() => setRevealId(null)}
        />
      )}
    </Card>
  )
}

/** Full submission content, loaded on demand (one reveal = one audit event). */
function SubmissionRevealDialog({
  userId,
  submissionId,
  onClose,
}: {
  userId: string
  submissionId: string
  onClose: () => void
}) {
  const { t } = useTranslation("users")
  const locale = useLocale()
  const { t: tErrors } = useTranslation("errors")
  const { data, isPending, isError } = useAdminUserSubmission(
    userId,
    submissionId
  )
  const entries = data ? Object.entries(data.data) : []

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("revealTitle")}</DialogTitle>
          <DialogDescription>
            {data
              ? `${data.form.name} · ${formatDateTime(locale, data.createdAt)} · ${data.originDomain}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        ) : isError || !data ? (
          <p className="text-sm text-destructive">{tErrors("generic")}</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("revealNoData")}</p>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("revealField")}</TableHead>
                  <TableHead>{t("revealValue")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map(([field, value]) => (
                  <TableRow key={field}>
                    <TableCell className="font-medium">{field}</TableCell>
                    <TableCell className="break-all">
                      {formatFieldValue(value)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
