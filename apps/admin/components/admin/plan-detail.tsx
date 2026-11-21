"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import {
  useArchivePlan,
  useCreatePlanVersion,
  useDuplicatePlan,
  usePlan,
  usePlanCompare,
  usePublishPlanVersion,
  type PlanDetail,
  type PlanVersionSummary,
} from "@sendcms/plans/queries"
import type { PlanEntitlements } from "@sendcms/plans/validators"
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
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@sendcms/ui"
import { RiArrowLeftLine, RiInformationLine } from "@remixicon/react"
import { useTranslation } from "@/components/admin/translation-provider"
import {
  formatDate,
  formatDateTime,
  formatLimit,
  formatPrice,
} from "./plan-format"
import {
  PlanVersionForm,
  type PlanVersionFormValues,
} from "./plan-version-form"

type DialogKind = "newVersion" | "publish" | "duplicate" | "archive" | null

type Props = {
  initialData: PlanDetail
  planId: string
  actorRole: PlatformRole | AdminRole
}

export function PlanDetailView({ initialData, planId, actorRole }: Props) {
  const { t } = useTranslation("plans")
  const router = useRouter()
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [publishVersionId, setPublishVersionId] = useState<string | null>(null)
  const [compareFrom, setCompareFrom] = useState<string | null>(
    initialData.currentVersion?.id ?? null
  )
  const [compareTo, setCompareTo] = useState<string | null>(
    initialData.versions[0]?.id ?? null
  )

  const { data } = usePlan(planId, initialData)
  const plan = data ?? initialData

  const canManage = adminCan(actorRole, "MANAGE_PLANS")
  const canPublish = adminCan(actorRole, "PUBLISH_PLAN_VERSIONS")

  const currentVersion = plan.versions.find(
    (v) => v.id === plan.currentVersion?.id
  )
  const latestVersion = plan.versions[0]

  function openPublish(versionId: string) {
    setPublishVersionId(versionId)
    setDialog("publish")
  }

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
          <Link href="/admin/plans">
            <RiArrowLeftLine className="size-4" aria-hidden="true" />
            {t("backToPlans")}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">{plan.name}</h1>
          <Badge variant="secondary">
            {plan.kind === "FREE" ? t("kindFree") : t("kindPaid")}
          </Badge>
          <Badge
            variant={plan.status === "PUBLISHED" ? "secondary" : "outline"}
          >
            {plan.status === "DRAFT"
              ? t("statusDraft")
              : plan.status === "PUBLISHED"
                ? t("statusPublished")
                : t("statusArchived")}
          </Badge>
          {plan.isPrivate && (
            <Badge variant="outline">{t("privateLabel")}</Badge>
          )}
        </div>
        <p className="text-muted-foreground">
          <span className="font-mono text-sm">{plan.slug}</span>
          {plan.description ? ` · ${plan.description}` : ""}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("colVersions")}: {plan.versionCount} · {t("colSubscriptions")}:{" "}
          {plan.subscriptionCount}
        </p>
      </div>

      {canManage && plan.status !== "ARCHIVED" && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setDialog("newVersion")}>
            {t("newVersion")}
          </Button>
          <Button variant="outline" onClick={() => setDialog("duplicate")}>
            {t("duplicate")}
          </Button>
          <Button variant="outline" onClick={() => setDialog("archive")}>
            {t("archive")}
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("currentVersionTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {!currentVersion ? (
            <p className="text-sm text-muted-foreground">
              {t("noCurrentVersion")}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <VersionField label={t("versionLabel")}>
                  v{currentVersion.version}
                </VersionField>
                <VersionField label={t("price")}>
                  {formatPrice(
                    currentVersion.priceAmount,
                    currentVersion.priceCurrency,
                    t("priceFree")
                  )}
                  {currentVersion.priceAmount !== null &&
                    ` · ${intervalLabel(currentVersion.billingInterval, t)}`}
                </VersionField>
                <VersionField label={t("trialDaysLabel")}>
                  {currentVersion.trialDays}
                </VersionField>
                <VersionField label={t("publishedAt")}>
                  {formatDateTime(currentVersion.publishedAt)}
                </VersionField>
              </dl>
              {currentVersion.changeReason && (
                <p className="text-sm text-muted-foreground">
                  {currentVersion.changeReason}
                </p>
              )}
              <EntitlementsTable entitlements={currentVersion.entitlements} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("historyTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colVersionNumber")}</TableHead>
                  <TableHead>{t("colVersionStatus")}</TableHead>
                  <TableHead>{t("colVersionPrice")}</TableHead>
                  <TableHead>{t("colVersionPublished")}</TableHead>
                  <TableHead>{t("colCreatedBy")}</TableHead>
                  <TableHead>{t("colChangeReason")}</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.versions.map((version) => (
                  <TableRow key={version.id}>
                    <TableCell className="font-medium">
                      v{version.version}
                    </TableCell>
                    <TableCell>
                      <VersionStatusBadge version={version} />
                    </TableCell>
                    <TableCell>
                      {formatPrice(
                        version.priceAmount,
                        version.priceCurrency,
                        t("priceFree")
                      )}
                    </TableCell>
                    <TableCell>{formatDate(version.publishedAt)}</TableCell>
                    <TableCell
                      className="font-mono text-xs"
                      title={version.createdById ?? ""}
                    >
                      {version.createdById
                        ? `${version.createdById.slice(0, 8)}…`
                        : "—"}
                    </TableCell>
                    <TableCell className="max-w-64 truncate">
                      {version.changeReason ?? "—"}
                    </TableCell>
                    <TableCell>
                      {canPublish && version.status === "DRAFT" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openPublish(version.id)}
                        >
                          {t("publish")}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("compareTitle")}</CardTitle>
          <CardDescription>{t("compareSelectPrompt")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <div className="space-y-1">
              <Label htmlFor="plan-compare-from">{t("compareFromLabel")}</Label>
              <Select
                value={compareFrom ?? ""}
                onValueChange={(value) => setCompareFrom(value || null)}
              >
                <SelectTrigger id="plan-compare-from" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {plan.versions.map((version) => (
                    <SelectItem key={version.id} value={version.id}>
                      {plan.name} v{version.version} (
                      {versionStatusLabel(version.status, t)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="plan-compare-to">{t("compareToLabel")}</Label>
              <Select
                value={compareTo ?? ""}
                onValueChange={(value) => setCompareTo(value || null)}
              >
                <SelectTrigger id="plan-compare-to" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {plan.versions.map((version) => (
                    <SelectItem key={version.id} value={version.id}>
                      {plan.name} v{version.version} (
                      {versionStatusLabel(version.status, t)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <VersionCompare fromId={compareFrom} toId={compareTo} />
        </CardContent>
      </Card>

      {dialog === "newVersion" && (
        <NewVersionDialog
          plan={plan}
          latestVersion={latestVersion}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "publish" && publishVersionId && (
        <PublishDialog
          planId={planId}
          versionId={publishVersionId}
          version={
            plan.versions.find((v) => v.id === publishVersionId)?.version
          }
          onClose={() => {
            setDialog(null)
            setPublishVersionId(null)
          }}
        />
      )}
      {dialog === "duplicate" && (
        <DuplicateDialog
          planId={planId}
          planName={plan.name}
          onClose={() => setDialog(null)}
          onDuplicated={(newPlanId) => {
            setDialog(null)
            router.push(`/admin/plans/${newPlanId}`)
          }}
        />
      )}
      {dialog === "archive" && (
        <ArchiveDialog planId={planId} onClose={() => setDialog(null)} />
      )}
    </main>
  )
}

function intervalLabel(interval: string, t: (key: string) => string): string {
  switch (interval) {
    case "MONTHLY":
      return t("intervalMonthly")
    case "ANNUAL":
      return t("intervalAnnual")
    case "CUSTOM":
      return t("intervalCustom")
    case "ONE_TIME":
      return t("intervalOneTime")
    default:
      return interval
  }
}

function versionStatusLabel(
  status: string,
  t: (key: string) => string
): string {
  switch (status) {
    case "DRAFT":
      return t("versionStatusDraft")
    case "PUBLISHED":
      return t("versionStatusPublished")
    case "SUPERSEDED":
      return t("versionStatusSuperseded")
    case "ARCHIVED":
      return t("versionStatusArchived")
    default:
      return status
  }
}

function VersionStatusBadge({ version }: { version: PlanVersionSummary }) {
  const { t } = useTranslation("plans")
  return (
    <Badge variant={version.status === "PUBLISHED" ? "secondary" : "outline"}>
      {versionStatusLabel(version.status, t)}
    </Badge>
  )
}

function VersionField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  )
}

/** The typed entitlement config as a readable table. */
export function EntitlementsTable({
  entitlements,
}: {
  entitlements: PlanEntitlements
}) {
  const { t } = useTranslation("plans")
  const unlimited = t("limitUnlimited")
  const rows: { label: string; value: string }[] = [
    { label: t("entForms"), value: formatLimit(entitlements.forms, unlimited) },
    {
      label: t("entDomains"),
      value: formatLimit(entitlements.domains, unlimited),
    },
    {
      label: t("entSubmissions"),
      value: formatLimit(entitlements.submissionsPerMonth, unlimited),
    },
    { label: t("entApiKeys"), value: String(entitlements.apiKeys) },
    {
      label: t("entAiRequests"),
      value: formatLimit(entitlements.aiRequestsPerDay, unlimited),
    },
    {
      label: t("entMcpMinute"),
      value: formatLimit(entitlements.mcpRequestsPerMinute, unlimited),
    },
    {
      label: t("entMcpHour"),
      value: formatLimit(entitlements.mcpRequestsPerHour, unlimited),
    },
    {
      label: t("entAiProviders"),
      value:
        entitlements.aiProviders.length > 0
          ? entitlements.aiProviders.join(", ")
          : "—",
    },
    {
      label: t("entByok"),
      value: entitlements.aiByokAllowed ? t("yes") : t("no"),
    },
    {
      label: t("entPlatformAi"),
      value: entitlements.aiPlatformAllowed ? t("yes") : t("no"),
    },
    {
      label: t("entFeatures"),
      value:
        entitlements.features.length > 0
          ? entitlements.features.join(", ")
          : "—",
    },
  ]
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("entitlementsTitle")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.label}>
              <TableCell className="text-muted-foreground">
                {row.label}
              </TableCell>
              <TableCell className="font-medium">{row.value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** Field-level before/after comparison of two versions. */
function VersionCompare({
  fromId,
  toId,
}: {
  fromId: string | null
  toId: string | null
}) {
  const { t } = useTranslation("plans")
  const { t: tErrors } = useTranslation("errors")
  const { data, isPending, isError } = usePlanCompare(fromId, toId)

  if (!fromId || !toId) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("compareSelectPrompt")}
      </p>
    )
  }
  if (isPending) {
    return <p className="text-sm text-muted-foreground">…</p>
  }
  if (isError || !data) {
    return <p className="text-sm text-destructive">{tErrors("generic")}</p>
  }
  if (data.changes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
        <RiInformationLine
          className="mb-4 size-10 text-muted-foreground"
          aria-hidden="true"
        />
        <h3 className="mb-1 text-lg font-semibold text-balance">
          {t("compareNoChanges")}
        </h3>
        <p className="max-w-sm text-sm text-muted-foreground">
          {t("compareNoChangesDescription")}
        </p>
      </div>
    )
  }
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("compareField")}</TableHead>
            <TableHead>
              {t("compareFrom")}: {data.from.planName} v{data.from.version}
            </TableHead>
            <TableHead>
              {t("compareTo")}: {data.to.planName} v{data.to.version}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.changes.map((change) => (
            <TableRow key={change.field}>
              <TableCell className="font-medium">{change.label}</TableCell>
              <TableCell>
                {formatDiffValue(change.field, change.from, data.from, t)}
              </TableCell>
              <TableCell>
                {formatDiffValue(change.field, change.to, data.to, t)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** Render one diff value field-aware (null = unlimited / free). */
function formatDiffValue(
  field: string,
  value: unknown,
  version: { priceCurrency: string },
  t: (key: string) => string
): string {
  const unlimited = t("limitUnlimited")
  if (field === "priceAmount") {
    return formatPrice(
      value as number | null,
      version.priceCurrency,
      t("priceFree")
    )
  }
  if (
    field === "forms" ||
    field === "domains" ||
    field === "submissionsPerMonth" ||
    field === "aiRequestsPerDay" ||
    field === "mcpRequestsPerMinute" ||
    field === "mcpRequestsPerHour"
  ) {
    return formatLimit(value as number | null, unlimited)
  }
  if (field === "billingInterval") {
    return intervalLabel(String(value), t)
  }
  if (field === "aiByokAllowed" || field === "aiPlatformAllowed") {
    return value === true ? t("yes") : t("no")
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "—"
  }
  if (value === null || value === undefined) return "—"
  return String(value)
}

function NewVersionDialog({
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
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
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

function PublishDialog({
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

function DuplicateDialog({
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

function ArchiveDialog({
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
