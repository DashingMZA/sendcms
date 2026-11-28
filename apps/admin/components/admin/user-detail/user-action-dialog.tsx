// User-detail confirm-action dialog (Wave 10, SRC-118 split of
// user-detail.tsx). The shell owns the action state and the mutations;
// this dialog only renders the copy + inputs for the pending action.
"use client"

import {
  Button,
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
  Textarea,
} from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"
import type { UserDetailActionKind } from "./shared"

type Props = {
  action: UserDetailActionKind | null
  reason: string
  roleValue: string
  // Already includes the pending state (confirmPending) — the shell
  // computes it so the confirm button disables while a mutation runs.
  confirmDisabled: boolean
  onReasonChange: (value: string) => void
  onRoleChange: (value: string) => void
  onClose: () => void
  onConfirm: () => void
}

export function UserActionDialog({
  action,
  reason,
  roleValue,
  confirmDisabled,
  onReasonChange,
  onRoleChange,
  onClose,
  onConfirm,
}: Props) {
  const { t } = useTranslation("users")

  const dialogCopy: Record<
    UserDetailActionKind,
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
    approve: {
      title: t("approveConfirmTitle"),
      description: t("approveConfirmBody"),
      confirm: t("confirmApprove"),
      destructive: false,
    },
    reject: {
      title: t("rejectConfirmTitle"),
      description: t("rejectConfirmBody"),
      confirm: t("confirmReject"),
      destructive: true,
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

  const reasonRequired =
    action === "suspend" ||
    action === "disable" ||
    action === "reject" ||
    action === "requestDeletion"
  const reasonOptional =
    action === "reactivate" || action === "restore" || action === "approve"

  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
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
                <Select value={roleValue} onValueChange={onRoleChange}>
                  <SelectTrigger id="user-role-select">
                    <SelectValue placeholder={t("roleLabel")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("roleNone")}</SelectItem>
                    <SelectItem value="SUPER_ADMIN">
                      {t("roleSuperAdmin")}
                    </SelectItem>
                    <SelectItem value="MANAGER">{t("roleManager")}</SelectItem>
                    <SelectItem value="SUPPORT">{t("roleSupport")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : reasonRequired || reasonOptional ? (
              <div className="space-y-1">
                <Label htmlFor="user-action-reason">{t("reasonLabel")}</Label>
                <Textarea
                  id="user-action-reason"
                  value={reason}
                  onChange={(e) => onReasonChange(e.target.value)}
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
              <Button variant="outline" onClick={onClose}>
                {t("cancel")}
              </Button>
              <Button
                variant={
                  dialogCopy[action].destructive ? "destructive" : "default"
                }
                onClick={onConfirm}
                disabled={confirmDisabled}
              >
                {dialogCopy[action].confirm}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
