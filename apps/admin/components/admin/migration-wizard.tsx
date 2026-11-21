"use client"

import { useRef, useState } from "react"
import { toast } from "sonner"
import { Search, X } from "lucide-react"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import { useAdminUsers } from "@sendcms/admin-users/queries"
import {
  useExecuteMigration,
  useMigrationPreview,
  usePlan,
  usePlans,
  type MigrationPreview,
} from "@sendcms/plans/queries"
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
import { useTranslation } from "@/components/admin/translation-provider"
import { formatPrice } from "./plan-format"

const DEBOUNCE_MS = 300

type Props = {
  actorRole: PlatformRole | AdminRole
}

type SelectedUser = { id: string; name: string | null; email: string }

export function MigrationWizard({ actorRole }: Props) {
  const { t } = useTranslation("subscriptions")
  const { t: tPlans } = useTranslation("plans")
  const canMigrate = adminCan(actorRole, "MIGRATE_SUBSCRIPTIONS")

  const [targetPlanId, setTargetPlanId] = useState("")
  const [scope, setScope] = useState<"all" | "users">("all")
  const [sourcePlanId, setSourcePlanId] = useState("")
  const [sourceVersionId, setSourceVersionId] = useState("")
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [selectedUsers, setSelectedUsers] = useState<Map<string, SelectedUser>>(
    new Map()
  )
  const [preview, setPreview] = useState<MigrationPreview | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [result, setResult] = useState<{
    migratedUserIds: string[]
    skippedUserIds: string[]
    count: number
  } | null>(null)

  const { data: plansData } = usePlans({
    page: 1,
    perPage: 100,
    sort: "createdAt:desc",
  })
  const plans = plansData?.plans ?? []
  const assignable = plans.filter((plan) => plan.currentVersion !== null)

  const targetPlan = assignable.find((plan) => plan.id === targetPlanId)
  const targetVersionId = targetPlan?.currentVersion?.id ?? null

  const { data: sourcePlan } = usePlan(sourcePlanId, undefined)

  const { data: usersData } = useAdminUsers({
    q: debouncedSearch || undefined,
    page: 1,
    perPage: 10,
    sort: "createdAt:desc",
  })
  const users = usersData?.users ?? []

  const previewMutation = useMigrationPreview()
  const executeMutation = useExecuteMigration()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  if (!canMigrate) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">
            {t("migrateNoPermission")}
          </p>
        </CardContent>
      </Card>
    )
  }

  function handleSearchChange(value: string) {
    setSearch(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(
      () => setDebouncedSearch(value.trim()),
      DEBOUNCE_MS
    )
  }

  function toggleUser(user: SelectedUser) {
    setSelectedUsers((prev) => {
      const next = new Map(prev)
      if (next.has(user.id)) next.delete(user.id)
      else next.set(user.id, user)
      return next
    })
  }

  const canPreview =
    targetVersionId !== null &&
    (scope === "all" ? sourceVersionId !== "" : selectedUsers.size > 0)

  async function runPreview() {
    if (!targetVersionId || !canPreview) return
    setResult(null)
    try {
      const data = await previewMutation.mutateAsync(
        scope === "all"
          ? { planVersionId: targetVersionId, allOnVersionId: sourceVersionId }
          : {
              planVersionId: targetVersionId,
              userIds: [...selectedUsers.keys()],
            }
      )
      setPreview(data)
    } catch {
      // Global mutation error toast already shown.
    }
  }

  // The preview shows the first 100 affected users, but execute
  // resolves the full set server-side: for the "all" scope pass
  // allOnVersionId (every active subscription on the source version),
  // for the "specific users" scope pass the admin's picked ids.
  async function runExecute(reason: string) {
    if (!targetVersionId) return
    if (scope === "users" && selectedUsers.size === 0) return
    if (scope === "all" && sourceVersionId === "") return
    try {
      const data = await executeMutation.mutateAsync(
        scope === "all"
          ? {
              planVersionId: targetVersionId,
              allOnVersionId: sourceVersionId,
              reason,
            }
          : {
              planVersionId: targetVersionId,
              userIds: [...selectedUsers.keys()],
              reason,
            }
      )
      setResult(data)
      toast.success(t("toastMigrationDone", { count: data.count }))
      setConfirmOpen(false)
      setPreview(null)
    } catch {
      // Global mutation error toast already shown.
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2 text-sm">
        <Badge variant="secondary">1 · {t("migrateStepTarget")}</Badge>
        <Badge variant="secondary">2 · {t("migrateStepScope")}</Badge>
        <Badge variant="secondary">3 · {t("migrateStepPreview")}</Badge>
        <Badge variant="secondary">4 · {t("migrateStepConfirm")}</Badge>
      </div>

      {/* Step 1 — target */}
      <Card>
        <CardHeader>
          <CardTitle>{t("migrateStepTarget")}</CardTitle>
          <CardDescription>{t("migrateTargetLabel")}</CardDescription>
        </CardHeader>
        <CardContent>
          {assignable.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("assignNoPlans")}
            </p>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="migrate-target-plan">
                {t("migrateTargetLabel")}
              </Label>
              <Select
                value={targetPlanId}
                onValueChange={(value) => {
                  setTargetPlanId(value)
                  setPreview(null)
                  setResult(null)
                }}
              >
                <SelectTrigger id="migrate-target-plan" className="w-72">
                  <SelectValue placeholder={t("migrateTargetPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {assignable.map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name} v{plan.currentVersion!.version}
                      {plan.currentVersion!.priceAmount !== null &&
                        ` · ${formatPrice(
                          plan.currentVersion!.priceAmount,
                          plan.currentVersion!.priceCurrency,
                          tPlans("priceFree")
                        )}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {targetPlan && targetVersionId && (
                <p className="text-sm text-muted-foreground">
                  {t("migrateTargetVersion", {
                    plan: targetPlan.name,
                    version: targetPlan.currentVersion!.version,
                  })}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Step 2 — scope */}
      <Card>
        <CardHeader>
          <CardTitle>{t("migrateStepScope")}</CardTitle>
          <CardDescription>{t("migrateScopeLabel")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="space-y-1">
            <Label htmlFor="migrate-scope">{t("migrateScopeLabel")}</Label>
            <Select
              value={scope}
              onValueChange={(value) => {
                setScope(value as "all" | "users")
                setPreview(null)
                setResult(null)
              }}
            >
              <SelectTrigger id="migrate-scope" className="w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("migrateScopeAll")}</SelectItem>
                <SelectItem value="users">{t("migrateScopeUsers")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {scope === "all"
                ? t("migrateScopeAllDescription")
                : t("migrateScopeUsersDescription")}
            </p>
          </div>

          {scope === "all" ? (
            <div className="flex flex-wrap gap-4">
              <div className="space-y-1">
                <Label htmlFor="migrate-source-plan">
                  {t("migrateSourceLabel")}
                </Label>
                <Select
                  value={sourcePlanId}
                  onValueChange={(value) => {
                    setSourcePlanId(value)
                    setSourceVersionId("")
                    setPreview(null)
                    setResult(null)
                  }}
                >
                  <SelectTrigger id="migrate-source-plan" className="w-56">
                    <SelectValue placeholder={t("migrateSourcePlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {plans.map((plan) => (
                      <SelectItem key={plan.id} value={plan.id}>
                        {plan.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="migrate-source-version">
                  {t("migrateSourceLabel")}
                </Label>
                <Select
                  value={sourceVersionId}
                  onValueChange={(value) => {
                    setSourceVersionId(value)
                    setPreview(null)
                    setResult(null)
                  }}
                  disabled={!sourcePlanId || !sourcePlan?.versions}
                >
                  <SelectTrigger id="migrate-source-version" className="w-56">
                    <SelectValue placeholder={t("migrateSourcePlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {(sourcePlan?.versions ?? []).map((version) => (
                      <SelectItem key={version.id} value={version.id}>
                        {sourcePlan?.name} v{version.version} ({version.status})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="relative max-w-md">
                <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={t("migrateUserSearchPlaceholder")}
                  value={search}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="pl-9"
                />
              </div>
              {users.length > 0 && (
                <div className="max-w-md rounded-lg border">
                  {users.map((user) => {
                    const selected = selectedUsers.has(user.id)
                    return (
                      <button
                        key={user.id}
                        type="button"
                        onClick={() => toggleUser(user)}
                        className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-accent"
                      >
                        <span>
                          <span className="block text-sm font-medium">
                            {user.name ?? "—"}
                          </span>
                          <span className="block text-sm text-muted-foreground">
                            {user.email}
                          </span>
                        </span>
                        {selected && <Badge variant="secondary">✓</Badge>}
                      </button>
                    )
                  })}
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                {t("migrateSelectedUsers", { count: selectedUsers.size })}
              </p>
              {selectedUsers.size > 0 && (
                <div className="flex flex-wrap gap-2">
                  {[...selectedUsers.values()].map((user) => (
                    <Badge key={user.id} variant="secondary" className="gap-1">
                      {user.email}
                      <button
                        type="button"
                        onClick={() => toggleUser(user)}
                        aria-label="Remove"
                      >
                        <X className="size-3" aria-hidden="true" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Step 3 — preview */}
      <Card>
        <CardHeader>
          <CardTitle>{t("migrateStepPreview")}</CardTitle>
          <CardDescription>{t("migratePreviewTitle")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <Button
              onClick={runPreview}
              disabled={!canPreview || previewMutation.isPending}
            >
              {t("migratePreview")}
            </Button>
          </div>
          {preview && (
            <>
              <p className="text-sm font-medium">
                {t("migrateAffectedCount", { count: preview.affectedCount })}
              </p>
              {preview.previewTruncated && (
                <p className="text-sm text-muted-foreground">
                  {t("migrateTruncated")}
                </p>
              )}
              {preview.users.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("migratePreviewEmpty")}
                </p>
              ) : (
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("migrateColUser")}</TableHead>
                        <TableHead>{t("migrateColFrom")}</TableHead>
                        <TableHead>{t("migrateColTo")}</TableHead>
                        <TableHead>{t("migrateColPrice")}</TableHead>
                        <TableHead>{t("migrateColChanges")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.users.map((row) => (
                        <TableRow key={row.userId}>
                          <TableCell>
                            <p className="font-medium">{row.name ?? "—"}</p>
                            <p className="text-sm text-muted-foreground">
                              {row.email}
                            </p>
                          </TableCell>
                          <TableCell>
                            {row.fromVersion
                              ? `${row.fromVersion.planName} v${row.fromVersion.version}`
                              : "—"}
                          </TableCell>
                          <TableCell>
                            {row.toVersion.planName} v{row.toVersion.version}
                          </TableCell>
                          <TableCell>
                            {t("migratePriceFromTo", {
                              from: formatPrice(
                                row.priceChange.from,
                                row.priceChange.currency,
                                tPlans("priceFree")
                              ),
                              to: formatPrice(
                                row.priceChange.to,
                                row.priceChange.currency,
                                tPlans("priceFree")
                              ),
                            })}
                          </TableCell>
                          <TableCell className="max-w-64">
                            {row.limitsChange.length === 0
                              ? t("migrateNoChanges")
                              : row.limitsChange
                                  .map((change) => change.label)
                                  .join(", ")}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {preview.affectedCount > 0 && (
                <div>
                  <Button onClick={() => setConfirmOpen(true)}>
                    {t("migrateStepConfirm")}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Result */}
      {result && (
        <Card>
          <CardHeader>
            <CardTitle>{t("migrateResultTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p>{t("migratedCount", { count: result.count })}</p>
            {result.skippedUserIds.length > 0 && (
              <p className="text-muted-foreground">
                {t("migrateSkipped", {
                  count: result.skippedUserIds.length,
                })}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {confirmOpen && preview && (
        <ConfirmMigrationDialog
          preview={preview}
          onClose={() => setConfirmOpen(false)}
          onConfirm={runExecute}
          pending={executeMutation.isPending}
        />
      )}
    </div>
  )
}

function ConfirmMigrationDialog({
  preview,
  onClose,
  onConfirm,
  pending,
}: {
  preview: MigrationPreview
  onClose: () => void
  onConfirm: (reason: string) => void
  pending: boolean
}) {
  const { t } = useTranslation("subscriptions")
  const [reason, setReason] = useState("")

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("migrateConfirmTitle")}</DialogTitle>
          <DialogDescription>
            {t("migrateConfirmDescription", {
              count: preview.affectedCount,
              plan: preview.targetPlan.name,
              version: preview.users[0]?.toVersion.version ?? 0,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="migrate-reason">{t("migrateReasonLabel")}</Label>
          <Textarea
            id="migrate-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("migrateReasonPlaceholder")}
            maxLength={500}
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            onClick={() => onConfirm(reason.trim())}
            disabled={pending || reason.trim() === ""}
          >
            {t("migrateExecute")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
