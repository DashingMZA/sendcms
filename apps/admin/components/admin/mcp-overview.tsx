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
  useMcpSettings,
  useMcpUsageSummary,
  useSetMcpSettings,
} from "@sendcms/mcp-admin/queries"
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
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"
import { formatErrorRate } from "./ai-format"
import { StepUpDialog } from "./step-up-dialog"

type Props = {
  actorRole: PlatformRole | AdminRole
}

/**
 * The MCP overview (Phase 6): the global kill-switch, real usage
 * numbers from the summary (total, success vs failed, 24h error
 * rate), a per-tool table, and the top 10 users. Every number comes
 * from the service; nothing here is hardcoded or fabricated. The
 * switch flips only after the mutation succeeds — the dialog asks
 * for the reason the service requires, and the displayed state comes
 * from the query data.
 */
export function McpOverview({ actorRole }: Props) {
  const { t } = useTranslation("mcp")
  const canViewMcp = adminCan(actorRole, "VIEW_MCP")
  const canManageMcp = adminCan(actorRole, "MANAGE_MCP")

  const {
    data: settings,
    isLoading: settingsLoading,
    isError: settingsError,
    refetch: refetchSettings,
  } = useMcpSettings()
  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
    refetch: refetchSummary,
  } = useMcpUsageSummary({})
  const setSettings = useSetMcpSettings()

  // The pending switch value: null = no dialog open.
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null)
  const [reason, setReason] = useState("")
  // Step-up (Phase 9): the password dialog for the kill-switch.
  const [stepUpOpen, setStepUpOpen] = useState(false)

  if (!canViewMcp) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("noPermission")}</p>
        </CardContent>
      </Card>
    )
  }

  const globalEnabled = settings?.globalEnabled ?? true

  function openSwitchDialog() {
    setReason("")
    setPendingEnabled(!globalEnabled)
  }

  async function confirmSwitch() {
    if (pendingEnabled === null) return
    try {
      await setSettings.mutateAsync({
        globalEnabled: pendingEnabled,
        reason: reason.trim(),
      })
      toast.success(t("killSwitchSaved"))
      setPendingEnabled(null)
      setReason("")
    } catch {
      // The query provider's global mutation error toast already
      // shows the failure — the dialog stays open to retry.
    }
  }

  const byTool = summary?.byTool ?? []
  const topUsers = summary?.topUsers ?? []

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle as="h2" className="flex flex-wrap items-center gap-2">
            {t("killSwitchTitle")}
            {settingsLoading ? (
              <Skeleton className="h-5 w-24" />
            ) : settingsError ? null : (
              <Badge variant={globalEnabled ? "secondary" : "destructive"}>
                {globalEnabled
                  ? t("killSwitchEnabled")
                  : t("killSwitchDisabled")}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>{t("killSwitchDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {/* AIM-012: a failed settings fetch is an error state, not
              a silently defaulted "enabled" switch. */}
          {settingsError ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm"
            >
              <span>{t("loadError")}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetchSettings()}
              >
                {t("retry")}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              {settingsLoading ? (
                <Skeleton className="h-6 w-11" />
              ) : (
                <Switch
                  checked={globalEnabled}
                  onCheckedChange={openSwitchDialog}
                  disabled={!canManageMcp}
                  aria-label={t("killSwitchTitle")}
                />
              )}
              <span className="text-sm font-medium">
                {globalEnabled
                  ? t("killSwitchEnabled")
                  : t("killSwitchDisabled")}
              </span>
            </div>
          )}
          <p className="text-sm font-medium">{t("killSwitchNote")}</p>
          <div>
            <Button variant="outline" asChild>
              <Link href="/admin/mcp/keys">{t("viewAllKeys")}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* AIM-012: a failed summary fetch shows an error state with
          a retry instead of literal zeros in every stat card. */}
      {summaryError ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-2 py-6">
            <p role="alert" className="text-sm text-destructive">
              {t("loadError")}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetchSummary()}
            >
              {t("retry")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader>
              <CardTitle as="h2">{t("totalCalls")}</CardTitle>
            </CardHeader>
            <CardContent>
              {summaryLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <p className="text-3xl font-bold tracking-tight">
                  {summary?.total ?? 0}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle as="h2">{t("successCalls")}</CardTitle>
            </CardHeader>
            <CardContent>
              {summaryLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <p className="text-3xl font-bold tracking-tight">
                  {summary?.success ?? 0}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle as="h2">{t("failedCalls")}</CardTitle>
            </CardHeader>
            <CardContent>
              {summaryLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <p className="text-3xl font-bold tracking-tight">
                  {summary?.failed ?? 0}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle as="h2">{t("errorRate24h")}</CardTitle>
            </CardHeader>
            <CardContent>
              {summaryLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <p className="text-3xl font-bold tracking-tight">
                  {formatErrorRate(summary?.errorRate24h ?? null)}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("byToolTitle")}</CardTitle>
          <CardDescription>{t("byToolDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {summaryLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : summaryError ? (
            <p role="alert" className="text-sm text-destructive">
              {t("loadError")}
            </p>
          ) : byTool.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("noCalls")}
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colTool")}</TableHead>
                    <TableHead>{t("colCalls")}</TableHead>
                    <TableHead>{t("colSuccess")}</TableHead>
                    <TableHead>{t("colFailed")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byTool.map((row) => (
                    <TableRow key={row.tool}>
                      <TableCell className="font-mono text-sm font-medium">
                        {row.tool}
                      </TableCell>
                      <TableCell>{row.calls}</TableCell>
                      <TableCell>{row.success}</TableCell>
                      <TableCell>{row.failed}</TableCell>
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
          <CardTitle as="h2">{t("topUsersTitle")}</CardTitle>
          <CardDescription>{t("topUsersDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {summaryLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : summaryError ? (
            <p role="alert" className="text-sm text-destructive">
              {t("loadError")}
            </p>
          ) : topUsers.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("topUsersEmpty")}
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colUser")}</TableHead>
                    <TableHead>{t("colCalls")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topUsers.map((user) => (
                    <TableRow key={user.userId}>
                      <TableCell className="font-medium">
                        <Link
                          href={`/admin/all-users/${user.userId}`}
                          className="hover:underline"
                        >
                          {user.name ?? user.email}
                        </Link>
                      </TableCell>
                      <TableCell>{user.calls}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={pendingEnabled !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingEnabled(null)
            setReason("")
          }
        }}
      >
        <DialogContent>
          {pendingEnabled !== null && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {pendingEnabled
                    ? t("killSwitchEnableTitle")
                    : t("killSwitchDisableTitle")}
                </DialogTitle>
                <DialogDescription>
                  {pendingEnabled
                    ? t("killSwitchEnableDescription")
                    : t("killSwitchDisableDescription")}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-1">
                <Label htmlFor="mcp-switch-reason">
                  {t("killSwitchReasonLabel")}
                </Label>
                <Textarea
                  id="mcp-switch-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t("killSwitchReasonPlaceholder")}
                  maxLength={500}
                  rows={3}
                />
                {reason.trim() === "" && (
                  <p className="text-sm text-destructive">
                    {t("killSwitchReasonRequired")}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPendingEnabled(null)
                    setReason("")
                  }}
                >
                  {t("cancel")}
                </Button>
                <Button
                  variant={pendingEnabled ? "default" : "destructive"}
                  onClick={() => setStepUpOpen(true)}
                  disabled={setSettings.isPending || reason.trim() === ""}
                >
                  {pendingEnabled
                    ? t("killSwitchConfirmEnable")
                    : t("killSwitchConfirmDisable")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <StepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => void confirmSwitch()}
      />
    </div>
  )
}
