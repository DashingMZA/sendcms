"use client"

import { usePlatformHealth } from "@sendcms/platform-ops/queries"
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"
import { formatErrorRate } from "./ai-format"

/** One small stat cell in a health card. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

/**
 * The platform health page (Phase 7): every number comes from
 * usePlatformHealth — real queries, no hardcoded stats, no fake
 * uptime. The DB ping is a live query with its latency; a failed
 * ping reports "disconnected" instead of throwing.
 */
export function HealthOverview() {
  const { t } = useTranslation("health")
  const { data, isLoading } = usePlatformHealth()

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t("databaseTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Stat
            label={t("dbStatus")}
            value={
              data.database.status === "connected"
                ? t("connected")
                : t("disconnected")
            }
          />
          <Stat
            label={t("dbLatency")}
            value={
              data.database.status === "connected"
                ? t("dbLatencyMs", { ms: data.database.latencyMs })
                : "—"
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("platformTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <Stat label={t("users")} value={String(data.counts.users)} />
          <Stat label={t("forms")} value={String(data.counts.forms)} />
          <Stat label={t("domains")} value={String(data.counts.domains)} />
          <Stat
            label={t("submissionsToday")}
            value={String(data.counts.submissionsToday)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("outboxTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <Stat
            label={t("outboxPending")}
            value={String(data.outbox.pending)}
          />
          <Stat
            label={t("outboxOldestAge")}
            value={
              data.outbox.oldestPendingAgeMinutes === null
                ? "—"
                : t("outboxOldestAgeMinutes", {
                    minutes: data.outbox.oldestPendingAgeMinutes,
                  })
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("aiTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <Stat label={t("aiCallsToday")} value={String(data.ai.callsToday)} />
          <Stat
            label={t("aiProvidersEnabled")}
            value={String(data.ai.providersEnabled)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("mcpTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <Stat
              label={t("mcpCalls24h")}
              value={String(data.mcp.callsLast24h)}
            />
            <Stat
              label={t("mcpErrorRate")}
              value={formatErrorRate(data.mcp.errorRate24h)}
            />
          </div>
          <p className="text-sm">
            <span className="text-muted-foreground">
              {t("mcpKillSwitch")}:{" "}
            </span>
            <Badge
              variant={data.mcp.globalEnabled ? "secondary" : "destructive"}
            >
              {data.mcp.globalEnabled ? t("enabled") : t("disabled")}
            </Badge>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("emergencyTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">
            <span className="text-muted-foreground">
              {t("emergencyFlag")}:{" "}
            </span>
            <Badge variant={data.emergency ? "destructive" : "secondary"}>
              {data.emergency ? t("on") : t("off")}
            </Badge>
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            {t("emergencyNote")}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
