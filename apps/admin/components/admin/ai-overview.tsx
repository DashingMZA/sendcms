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

  const { data: summary, isLoading: summaryLoading } = useAiUsageSummary({})
  const { data: health, isLoading: healthLoading } = useProviderHealth()

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
            <p className="text-sm text-muted-foreground">
              {t("successCalls")}: {total?.success ?? 0} · {t("failedCalls")}:{" "}
              {total?.failed ?? 0}
            </p>
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
            <p className="text-sm text-muted-foreground">
              {t("tokensIn")}: {byok?.tokensIn ?? 0} · {t("tokensOut")}:{" "}
              {byok?.tokensOut ?? 0}
            </p>
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
            <p className="text-sm text-muted-foreground">
              {t("tokensIn")}: {platform?.tokensIn ?? 0} · {t("tokensOut")}:{" "}
              {platform?.tokensOut ?? 0}
            </p>
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

      {canManageAi && (
        <Card>
          <CardHeader>
            <CardTitle>{t("healthTitle")}</CardTitle>
            <CardDescription>{t("healthDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            {healthLoading ? (
              <Skeleton className="h-32 w-full" />
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
