// Job detail dialog content (Phase C, plan §3.6): the selected queue
// row's fields plus the attempts/backoff timeline. The dialog renders
// from the list row alone — every field it needs (attempts,
// nextAttemptAt, lastError, providerMessageId, deliveryStatus,
// claimedAt) already travels with the row, so no detail fetch is
// needed; the dedicated detail endpoint
// (GET /api/v1/admin/jobs/email/[jobId]) stays available to the API
// layer. The backoff ladder comes from the client-safe copy in
// @/lib/jobs-format, never from the service barrel.
"use client"

import { Badge } from "@sendcms/ui"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import {
  MAX_EMAIL_ATTEMPTS,
  backoffDelayMinutesAfterAttempt,
  describeBackoffDelay,
} from "@/lib/jobs-format"
import { formatDateTime } from "./plan-format"
import type { AdminEmailJobRow } from "./jobs-queue-table"

const STATUS_BADGE_VARIANT: Record<
  AdminEmailJobRow["status"],
  "secondary" | "outline" | "destructive"
> = {
  PENDING: "outline",
  SENDING: "secondary",
  SENT: "secondary",
  FAILED: "destructive",
}

const STATUS_LABEL_KEYS: Record<AdminEmailJobRow["status"], string> = {
  PENDING: "statusPending",
  SENDING: "statusSending",
  SENT: "statusSent",
  FAILED: "statusFailed",
}

const TYPE_LABEL_KEYS: Record<AdminEmailJobRow["type"], string> = {
  SUBMISSION_NOTIFICATION: "typeSubmissionNotification",
  EMAIL_VERIFICATION: "typeEmailVerification",
  PASSWORD_RESET: "typePasswordReset",
  DIGEST: "typeDigest",
  SUBMISSION_REPLY: "typeSubmissionReply",
  TEST_EMAIL: "typeTestEmail",
}

function delayLabel(
  t: (key: string, vars?: Record<string, string | number>) => string,
  minutes: number
): string {
  const parts = describeBackoffDelay(minutes)
  return parts.unit === "hours"
    ? t("delayHours", { hours: parts.value })
    : t("delayMinutes", { minutes: parts.value })
}

export function JobsJobDetail({ job }: { job: AdminEmailJobRow }) {
  const { t } = useTranslation("jobs")
  const locale = useLocale()

  // Timeline rows 1..6: done once the attempt happened, "next" for
  // the attempt the job is waiting on, upcoming after that. A SENT
  // job stops the ladder — rows past its attempt count stay upcoming.
  const rows = Array.from({ length: MAX_EMAIL_ATTEMPTS }, (_, i) => i + 1)

  return (
    <div className="flex flex-col gap-5 text-sm">
      <div className="flex flex-col gap-3">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">{t("detailTo")}</span>
          <span className="text-right font-medium break-all">{job.to}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">{t("detailSubject")}</span>
          <span className="text-right font-medium">{job.subject}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">{t("detailType")}</span>
          <span>{t(TYPE_LABEL_KEYS[job.type])}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">{t("detailStatus")}</span>
          <Badge variant={STATUS_BADGE_VARIANT[job.status]}>
            {t(STATUS_LABEL_KEYS[job.status])}
          </Badge>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">{t("detailOwner")}</span>
          <span className="text-right font-medium">
            {(job.ownerName ?? job.ownerEmail) || t("unknownOwner")}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">{t("detailForm")}</span>
          <span>{job.formName ?? "—"}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">{t("detailAttempts")}</span>
          <span>
            {job.attempts} / {MAX_EMAIL_ATTEMPTS}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">{t("detailCreated")}</span>
          <span>{formatDateTime(locale, job.createdAt)}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">
            {t("detailNextAttempt")}
          </span>
          <span>
            {job.nextAttemptAt
              ? formatDateTime(locale, job.nextAttemptAt)
              : "—"}
          </span>
        </div>
        {job.claimedAt && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">
              {t("detailClaimedAt")}
            </span>
            <span>{formatDateTime(locale, job.claimedAt)}</span>
          </div>
        )}
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">
            {t("detailProviderMessageId")}
          </span>
          <span className="font-mono text-xs">
            {job.providerMessageId ?? "—"}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">
            {t("detailDeliveryStatus")}
          </span>
          <span>{job.deliveryStatus ?? t("detailDeliveryUnknown")}</span>
        </div>
        {job.lastError && (
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">
              {t("detailLastError")}
            </span>
            <p className="rounded-md bg-muted p-2 text-xs break-words">
              {job.lastError}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="font-medium">{t("detailTimelineTitle")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("detailTimelineDescription")}
        </p>
        <ol className="flex flex-col gap-1">
          {rows.map((attempt) => {
            const done = attempt <= job.attempts
            const isNext =
              !done &&
              attempt === job.attempts + 1 &&
              (job.status === "PENDING" || job.status === "FAILED")
            const delay = backoffDelayMinutesAfterAttempt(attempt)
            return (
              <li
                key={attempt}
                className="flex items-center justify-between gap-4 rounded-md border px-3 py-2"
              >
                <span>{t("attemptNumber", { attempt })}</span>
                <span className="text-muted-foreground">
                  {delay === null
                    ? t("attemptTerminal")
                    : t("attemptRetryAfter", {
                        delay: delayLabel(t, delay),
                      })}
                </span>
                <Badge variant={done ? "secondary" : "outline"}>
                  {done
                    ? t("attemptDone")
                    : isNext
                      ? t("attemptNext")
                      : t("attemptUpcoming")}
                </Badge>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
