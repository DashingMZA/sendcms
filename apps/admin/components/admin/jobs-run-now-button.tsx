// "Run now" action for the Jobs page header (Phase C, plan §3.6,
// Wave 10 UX-110: the PageHeader action slot holds the page's single
// primary action; no in-content duplicate).
//
// Manual cron trigger, capability-gated (Q9 MANAGE_JOBS —
// SUPER_ADMIN + owner, enforced by the service) and audit-logged by
// the service. The service also requires step-up re-auth (single-use),
// so the confirm button opens the shared StepUpDialog first and the
// mutation runs only onVerified — the payments refund flow, not a
// new pattern.
"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useRunCronNow } from "@sendcms/cron/queries"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sendcms/ui"
import { RiPlayLine } from "@remixicon/react"
import { useTranslation } from "@/components/admin/translation-provider"
import { StepUpDialog } from "./step-up-dialog"

export function JobsRunNowButton({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation("jobs")
  const router = useRouter()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [stepUpOpen, setStepUpOpen] = useState(false)

  const runNow = useRunCronNow()

  if (!canManage) return null

  async function confirmRun() {
    try {
      await runNow.mutateAsync()
      toast.success(t("runNowToast"))
      setConfirmOpen(false)
      router.refresh()
    } catch {
      // The global mutation error toast reports the failure; the
      // dialog stays open so the admin can retry.
    }
  }

  return (
    <>
      <Button onClick={() => setConfirmOpen(true)}>
        <RiPlayLine className="size-4" aria-hidden="true" />
        {t("runNow")}
      </Button>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("runNowTitle")}</DialogTitle>
            <DialogDescription>{t("runNowDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t("runNowCancel")}
            </Button>
            <Button
              disabled={runNow.isPending}
              onClick={() => setStepUpOpen(true)}
            >
              {runNow.isPending ? t("runNowRunning") : t("runNowConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Step-up: the manual run sends customer email, so the service
          requires a password re-entry (single-use) before it runs. */}
      <StepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => void confirmRun()}
      />
    </>
  )
}
