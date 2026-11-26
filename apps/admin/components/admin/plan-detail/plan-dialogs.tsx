// Plan version dialogs (Wave 10, SRC-118 split of plan-detail.tsx):
// new version, publish, duplicate, archive.
"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  useArchivePlan,
  useCreatePlanVersion,
  useDuplicatePlan,
  usePublishPlanVersion,
  type PlanDetail,
  type PlanVersionSummary,
} from "@sendcms/plans/queries"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
} from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"
import {
  PlanVersionForm,
  type PlanVersionFormValues,
} from "../plan-version-form"

export function NewVersionDialog({
  plan,
  latestVersion,
  onClose,
}: {
  plan: PlanDetail
  latestVersion: PlanVersionSummary | undefined
  onClose: () => void
}) {
  const { t } = useTranslation("plans")
  const [changeReason, setChangeReason] = useState("")
  const createVersion = useCreatePlanVersion(plan.id)

  const initial: PlanVersionFormValues = latestVersion
    ? {
        priceAmount: latestVersion.priceAmount,
        priceCurrency: latestVersion.priceCurrency,
        billingInterval: latestVersion.billingInterval,
        trialDays: latestVersion.trialDays,
        entitlements: latestVersion.entitlements,
      }
    : {
        priceAmount: null,
        priceCurrency: "USD",
        billingInterval: "MONTHLY",
        trialDays: 0,
        entitlements: {
          forms: null,
          domains: null,
          submissionsPerMonth: null,
          apiKeys: 10,
          aiRequestsPerDay: 100,
          mcpRequestsPerMinute: 120,
          mcpRequestsPerHour: 2000,
          aiProviders: [
            "openai",
            "anthropic",
            "google",
            "deepseek",
            "openrouter",
          ],
          aiByokAllowed: true,
          aiPlatformAllowed: true,
          features: [],
        },
      }

  async function handleSubmit(values: PlanVersionFormValues) {
    try {
      await createVersion.mutateAsync({
        priceAmount: values.priceAmount,
        priceCurrency: values.priceCurrency,
        billingInterval: values.billingInterval,
        trialDays: values.trialDays,
        entitlements: values.entitlements,
        changeReason: changeReason.trim() || undefined,
      })
      toast.success(t("toastVersionCreated"))
      onClose()
    } catch {
      // Global mutation error toast already shown.
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[42rem]">
        <DialogHeader>
          <DialogTitle>{t("newVersionTitle")}</DialogTitle>
          <DialogDescription>{t("newVersionDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="plan-version-reason">{t("changeReasonLabel")}</Label>
          <Textarea
            id="plan-version-reason"
            value={changeReason}
            onChange={(e) => setChangeReason(e.target.value)}
            placeholder={t("changeReasonPlaceholder")}
            maxLength={500}
            rows={2}
          />
        </div>
        <PlanVersionForm
          initial={initial}
          onSubmit={handleSubmit}
          onCancel={onClose}
          submitLabel={t("newVersionSubmit")}
          pending={createVersion.isPending}
        />
      </DialogContent>
    </Dialog>
  )
}

export function PublishDialog({
  planId,
  versionId,
  version,
  onClose,
}: {
  planId: string
  versionId: string
  version: number | undefined
  onClose: () => void
}) {
  const { t } = useTranslation("plans")
  const [reason, setReason] = useState("")
  const publish = usePublishPlanVersion(planId, versionId)

  async function confirm() {
    if (!reason.trim()) return
    try {
      await publish.mutateAsync({ reason: reason.trim() })
      toast.success(t("toastPublished"))
      onClose()
    } catch {
      // Global mutation error toast already shown.
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("publishTitle")}
            {version !== undefined ? ` — v${version}` : ""}
          </DialogTitle>
          <DialogDescription>{t("publishDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="plan-publish-reason">{t("publishReasonLabel")}</Label>
          <Textarea
            id="plan-publish-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("publishReasonPlaceholder")}
            maxLength={500}
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            onClick={confirm}
            disabled={publish.isPending || reason.trim() === ""}
          >
            {t("publishSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DuplicateDialog({
  planId,
  planName,
  onClose,
  onDuplicated,
}: {
  planId: string
  planName: string
  onClose: () => void
  onDuplicated: (newPlanId: string) => void
}) {
  const { t } = useTranslation("plans")
  const [name, setName] = useState(`${planName} (copy)`)
  const [slug, setSlug] = useState("")
  const duplicate = useDuplicatePlan(planId)

  async function confirm() {
    if (!name.trim() || !slug.trim()) return
    try {
      const plan = await duplicate.mutateAsync({
        name: name.trim(),
        slug: slug.trim(),
      })
      toast.success(t("toastDuplicated"))
      onDuplicated(plan.id)
    } catch {
      // Global mutation error toast already shown.
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("duplicateTitle")}</DialogTitle>
          <DialogDescription>{t("duplicateDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="space-y-1">
            <Label htmlFor="plan-duplicate-name">{t("nameLabel")}</Label>
            <Input
              id="plan-duplicate-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="plan-duplicate-slug">{t("slugLabel")}</Label>
            <Input
              id="plan-duplicate-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder={t("slugPlaceholder")}
              maxLength={100}
            />
            <p className="text-xs text-muted-foreground">{t("slugHint")}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            onClick={confirm}
            disabled={duplicate.isPending || !name.trim() || !slug.trim()}
          >
            {t("duplicateSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ArchiveDialog({
  planId,
  onClose,
}: {
  planId: string
  onClose: () => void
}) {
  const { t } = useTranslation("plans")
  const [reason, setReason] = useState("")
  const archive = useArchivePlan(planId)

  async function confirm() {
    try {
      await archive.mutateAsync(reason.trim() ? { reason: reason.trim() } : {})
      toast.success(t("toastArchived"))
      onClose()
    } catch {
      // Global mutation error toast already shown.
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("archiveTitle")}</DialogTitle>
          <DialogDescription>{t("archiveDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="plan-archive-reason">{t("archiveReasonLabel")}</Label>
          <Textarea
            id="plan-archive-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={confirm}
            disabled={archive.isPending}
          >
            {t("archiveSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
