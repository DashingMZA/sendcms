"use client"

import { usePlatformHealth } from "@sendcms/platform-ops/queries"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@sendcms/ui"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDateTime } from "./plan-format"
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
  const locale = useLocale()
  const { data, isLoading, isError, refetch, dataUpdatedAt } =
    usePlatformHealth()

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

  if (isError) {
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-2 py-10">
          <p role="alert" className="text-sm text-destructive">
            {t("loadError")}
          </p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            {t("retry")}
          </Button>
        </CardContent>
      </Card>
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
    <div className="flex flex-col gap-4">
      {/* ADM-100: the page refetches every 30 s (usePlatformHealth) —
          show when these numbers were fetched so staleness is visible. */}
      <p className="text-sm text-muted-foreground">
        {t("asOf", {
          time: new Date(dataUpdatedAt).toLocaleTimeString(),
        })}
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("databaseTitle")}</CardTitle>
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
            <CardTitle as="h2">{t("platformTitle")}</CardTitle>
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
            <CardTitle as="h2">{t("outboxTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4">
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
              {/* EML-092: the queue as a breakdown — a bare pending
                  count hid FAILED jobs, stuck SENDING jobs, and the
                  worker/cron state entirely. */}
              <Stat
                label={t("pendingDue")}
                value={String(data.outbox.pendingDue)}
              />
              <Stat label={t("sending")} value={String(data.outbox.sending)} />
              <Stat label={t("failed")} value={String(data.outbox.failed)} />
              <Stat
                label={t("stuckSendingAge")}
                value={
                  data.outbox.stuckSendingAgeMinutes === null
                    ? "—"
                    : t("outboxOldestAgeMinutes", {
                        minutes: data.outbox.stuckSendingAgeMinutes,
                      })
                }
              />
            </div>
            <p className="text-sm">
              <span className="text-muted-foreground">
                {t("lastCronRun")}:{" "}
              </span>
              {formatDateTime(locale, data.outbox.lastCronRunAt)}
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">
                {t("workerLastRun")}:{" "}
              </span>
              {formatDateTime(locale, data.outbox.worker.lastRunAt)}
            </p>
            {data.outbox.worker.lastError && (
              <p className="text-sm">
                <span className="text-muted-foreground">
                  {t("workerLastError")}:{" "}
                </span>
                <span className="text-destructive">
                  {data.outbox.worker.lastError}
                </span>
              </p>
            )}
            {/* PRF-018: the outbox is stale — the oldest pending job
                has waited over an hour, so the drain (cron route or
                worker) has stopped running or a provider outage is
                holding every job. Visible alert, not a plain stat. */}
            {data.outbox.outboxStale && (
              <p
                role="alert"
                className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {t("outboxStaleAlert", {
                  minutes: data.outbox.oldestPendingAgeMinutes ?? 0,
                })}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("aiTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <Stat
              label={t("aiCallsToday")}
              value={String(data.ai.callsToday)}
            />
            <Stat
              label={t("aiProvidersEnabled")}
              value={String(data.ai.providersEnabled)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("mcpTitle")}</CardTitle>
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
            <CardTitle as="h2">{t("emergencyTitle")}</CardTitle>
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

        {/* ADM-124: the security posture — limiter config from
            config.json (never hardcoded) + this admin's own bucket
            counts for the current windows + the CSP mode. */}
        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("securityTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4">
              <Stat
                label={t("adminApiPerMinute")}
                value={String(
                  data.securityPosture.rateLimit.config.adminApi.perMinute
                )}
              />
              <Stat
                label={t("adminApiPerHour")}
                value={String(
                  data.securityPosture.rateLimit.config.adminApi.perHour
                )}
              />
              <Stat
                label={t("ownBucketMinute")}
                value={
                  data.securityPosture.rateLimit.ownBucket === null
                    ? "—"
                    : String(
                        data.securityPosture.rateLimit.ownBucket.minuteCount
                      )
                }
              />
              <Stat
                label={t("ownBucketHour")}
                value={
                  data.securityPosture.rateLimit.ownBucket === null
                    ? "—"
                    : String(data.securityPosture.rateLimit.ownBucket.hourCount)
                }
              />
            </div>
            {data.securityPosture.rateLimit.ownBucket === null && (
              <p className="text-sm text-muted-foreground">
                {t("ownBucketNone")}
              </p>
            )}
            <p className="text-sm">
              <span className="text-muted-foreground">{t("cspMode")}: </span>
              {data.securityPosture.csp.mode === "enforcing"
                ? t("cspEnforcing")
                : t("cspReportOnly")}
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">
                {t("cspReporting")}:{" "}
              </span>
              {data.securityPosture.csp.reportingConfigured
                ? t("cspReportingYes")
                : t("cspReportingNo")}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
