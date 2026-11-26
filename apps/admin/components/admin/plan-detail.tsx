// Plan detail shell (Wave 10, SRC-118 split): the page header (shared
// PageHeader, UX-005/UX-008), the action buttons, the current-version
// card, the version-history card, and the compare card. The entitlements
// table, the version comparison, and the version dialogs live in
// ./plan-detail/.
"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import {
  usePlan,
  type PlanDetail,
  type PlanVersionSummary,
} from "@sendcms/plans/queries"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
} from "@sendcms/ui"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDate, formatDateTime, formatPrice } from "./plan-format"
import { PageHeader } from "./page-header"
import { EntitlementsTable } from "./plan-detail/entitlements-table"
import {
  ArchiveDialog,
  DuplicateDialog,
  NewVersionDialog,
  PublishDialog,
} from "./plan-detail/plan-dialogs"
import {
  VersionCompare,
  intervalLabel,
  versionStatusLabel,
} from "./plan-detail/version-compare"

// Re-exported so existing import sites keep working after the split.
export { EntitlementsTable }

type DialogKind = "newVersion" | "publish" | "duplicate" | "archive" | null

type Props = {
  initialData: PlanDetail
  planId: string
  actorRole: PlatformRole | AdminRole
}

export function PlanDetailView({ initialData, planId, actorRole }: Props) {
  const { t } = useTranslation("plans")
  const locale = useLocale()
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
    <div>
      <PageHeader
        title={plan.name}
        description={
          <>
            <span className="font-mono text-xs">{plan.slug}</span>
            {plan.description ? ` · ${plan.description}` : ""}
          </>
        }
        back={{ href: "/admin/plans", label: t("backToPlans") }}
        action={
          <div className="flex flex-wrap items-center gap-2">
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
        }
      />
      <main id="main-content" className="flex flex-col gap-6 p-6">
        <p className="text-sm text-muted-foreground">
          {t("colVersions")}: {plan.versionCount} · {t("colSubscriptions")}:{" "}
          {plan.subscriptionCount}
        </p>

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
                      locale,
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
                    {formatDateTime(locale, currentVersion.publishedAt)}
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
                          locale,
                          version.priceAmount,
                          version.priceCurrency,
                          t("priceFree")
                        )}
                      </TableCell>
                      <TableCell>
                        {formatDate(locale, version.publishedAt)}
                      </TableCell>
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
                <Label htmlFor="plan-compare-from">
                  {t("compareFromLabel")}
                </Label>
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
    </div>
  )
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
