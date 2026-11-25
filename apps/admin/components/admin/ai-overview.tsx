"use client"

import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import {
  useAiUsageSummary,
  useProviderHealth,
} from "@sendcms/ai-settings/queries"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"
import {
  formatCostMicros,
  formatErrorRate,
  providerDisplayName,
} from "./ai-format"

type Props = {
  actorRole: PlatformRole | AdminRole
}

/**
 * The AI overview (Phase 5): real numbers from the usage summary and
 * provider health — total calls, the BYOK vs platform split (never
 * mixed), success vs failed, and per-provider health. Every number
 * comes from the service; nothing here is hardcoded or fabricated.
 */
export function AiOverview({ actorRole }: Props) {
  const { t } = useTranslation("ai")
  const canViewUsage = adminCan(actorRole, "VIEW_AI_USAGE")
  const canManageAi = adminCan(actorRole, "MANAGE_AI")

  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
    refetch: refetchSummary,
  } = useAiUsageSummary({})
  const {
    data: health,
    isLoading: healthLoading,
    isError: healthError,
    refetch: refetchHealth,
  } = useProviderHealth()

  if (!canViewUsage) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("noPermission")}</p>
        </CardContent>
      </Card>
    )
  }

  const total = summary?.total
  const byok = summary?.byok
  const platform = summary?.platform
  const totalCost = total ? formatCostMicros(total.costMicros) : null

  return (
    <div className="flex flex-col gap-6">
      {/* AIM-012: a failed summary fetch shows an error state instead
          of literal zeros; the breakdown lines skeleton while loading
          (only the headline total had a skeleton before). The provider
          health section below still renders. */}
      {summaryError ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-2 py-10">
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
              <CardTitle>{t("totalCalls")}</CardTitle>
            </CardHeader>
            <CardContent>
              {summaryLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <p className="text-3xl font-bold tracking-tight">
                  {total?.calls ?? 0}
                </p>
              )}
              {summaryLoading ? (
                <Skeleton className="mt-2 h-4 w-32" />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("successCalls")}: {total?.success ?? 0} ·{" "}
                  {t("failedCalls")}: {total?.failed ?? 0}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("byokCalls")}</CardTitle>
            </CardHeader>
            <CardContent>
              {summaryLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <p className="text-3xl font-bold tracking-tight">
                  {byok?.calls ?? 0}
                </p>
              )}
              {summaryLoading ? (
                <Skeleton className="mt-2 h-4 w-32" />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("tokensIn")}: {byok?.tokensIn ?? 0} · {t("tokensOut")}:{" "}
                  {byok?.tokensOut ?? 0}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("platformCalls")}</CardTitle>
            </CardHeader>
            <CardContent>
              {summaryLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <p className="text-3xl font-bold tracking-tight">
                  {platform?.calls ?? 0}
                </p>
              )}
              {summaryLoading ? (
                <Skeleton className="mt-2 h-4 w-32" />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("tokensIn")}: {platform?.tokensIn ?? 0} · {t("tokensOut")}:{" "}
                  {platform?.tokensOut ?? 0}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("costReported")}</CardTitle>
              <CardDescription>{t("costNote")}</CardDescription>
            </CardHeader>
            <CardContent>
              {summaryLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <p className="text-3xl font-bold tracking-tight">
                  {totalCost ?? "—"}
                </p>
              )}
              {!summaryLoading && totalCost === null && (
                <p className="text-sm text-muted-foreground">
                  {t("costNotReported")}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {canManageAi && (
        <Card>
          <CardHeader>
            <CardTitle>{t("healthTitle")}</CardTitle>
            <CardDescription>{t("healthDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            {healthLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : healthError ? (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm"
              >
                <span>{t("loadError")}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void refetchHealth()}
                >
                  {t("retry")}
                </Button>
              </div>
            ) : !health || health.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noCalls")}</p>
            ) : (
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("colProvider")}</TableHead>
                      <TableHead>{t("colEnabled")}</TableHead>
                      <TableHead>{t("colPlatformKey")}</TableHead>
                      <TableHead>{t("colCalls24h")}</TableHead>
                      <TableHead>{t("colFailed24h")}</TableHead>
                      <TableHead>{t("colErrorRate")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {health.map((row) => (
                      <TableRow key={row.provider}>
                        <TableCell className="font-medium">
                          {providerDisplayName(row.provider)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">
                            {row.isEnabled ? t("enabled") : t("disabled")}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {row.platformKeyConfigured
                            ? t("keyConfigured")
                            : t("keyNotConfigured")}
                        </TableCell>
                        <TableCell>{row.calls24h}</TableCell>
                        <TableCell>{row.failed24h}</TableCell>
                        <TableCell>{formatErrorRate(row.errorRate)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
