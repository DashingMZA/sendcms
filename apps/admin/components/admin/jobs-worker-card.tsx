// Worker status card (Phase C, plan §3.6, Q12).
//
// DERIVED state only — the last completed job, the last cron run, the
// queue depth, and the stuck age, all derived in the page from the
// same service calls as the queue and cron sections. Q12
// (owner-approved): no row is ever presented as live when it is
// derived — the labels say "last seen", never "live". The standalone
// worker's /health endpoint (:3005) is NOT consumed by any admin UI
// or route today, so this card never fetches it (it would need a
// WORKER_URL env + a network path on Vercel); the follow-up note says
// so and links to the Health page instead. No alerting here (PRF-018
// — Wave 11).
"use client"

import Link from "next/link"
import { formatNumber } from "@sendcms/i18n"
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sendcms/ui"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDateTime } from "./plan-format"

/** Derived worker status as the page computes it from the queue
    depth, the queue list, and the latest cron run — no live fetch. */
export type JobsWorkerStatus = {
  /** Newest completed (SENT/FAILED) job in the fetched queue page, or
      null when the page holds none. Labelled "last seen", never live. */
  lastCompletedJobAt: string | null
  /** The latest cron run's start, or null when no run is recorded. */
  lastCronRunAt: string | null
  lastCronRunStatus: string | null
  queueDepth: {
    pending: number
    pendingDue: number
    sending: number
    failed: number
  }
  /** Age in minutes of the oldest SENDING row, null when none. */
  stuckAgeMinutes: number | null
}

export function JobsWorkerCard({ status }: { status: JobsWorkerStatus }) {
  const { t } = useTranslation("jobs")
  const locale = useLocale()

  const lastSeen = (at: string | null) =>
    at ? t("lastSeen", { time: formatDateTime(locale, at) }) : t("workerNever")

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("workerTitle")}</CardTitle>
        <CardDescription>{t("workerDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">
            {t("workerLastCompletedJob")}
          </span>
          <span>{lastSeen(status.lastCompletedJobAt)}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">
            {t("workerLastCronRun")}
          </span>
          <span className="flex items-center gap-2">
            {status.lastCronRunStatus && (
              <Badge
                variant={
                  status.lastCronRunStatus === "FAILED"
                    ? "destructive"
                    : status.lastCronRunStatus === "SUCCESS"
                      ? "secondary"
                      : "outline"
                }
              >
                {status.lastCronRunStatus}
              </Badge>
            )}
            {lastSeen(status.lastCronRunAt)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">{t("workerQueueDepth")}</span>
          <span>
            {t("queueDepthSummary", {
              pending: formatNumber(locale, status.queueDepth.pending),
              sending: formatNumber(locale, status.queueDepth.sending),
              failed: formatNumber(locale, status.queueDepth.failed),
            })}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">{t("workerStuckAge")}</span>
          <span>
            {status.stuckAgeMinutes === null
              ? t("stuckAgeNone")
              : t("stuckAgeMinutes", { minutes: status.stuckAgeMinutes })}
          </span>
        </div>
        <p className="text-muted-foreground">{t("workerFollowUp")}</p>
        <Link
          href="/admin/health"
          className="text-sm font-medium hover:underline"
        >
          {t("workerFollowUpLink")}
        </Link>
      </CardContent>
    </Card>
  )
}
