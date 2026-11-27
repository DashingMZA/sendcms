// Cron-run table (Phase C, plan §3.6 — thin table on the
// payments-table shape).
//
// Server-fed: the page fetches the list, this component renders it —
// job, trigger, status, started/finished, duration, and an expandable
// per-step breakdown. Filters (status, trigger) and pagination are
// URL-as-state, like the other admin tables.
//
// The `CronRun` model + `listCronRuns` live with Stream A; the row
// type below is local to this file and mirrors the plan §3.6 model
// (jobName / trigger / status / startedAt / finishedAt / durationMs /
// steps). The page maps the service rows onto it (dates → ISO
// strings); this component never imports a service barrel. The steps
// render generically — each step key maps to a label, each step value
// to processed/sent/failed/skipped counts plus an error line — so the
// table tolerates the writer's exact step shape without a second
// model.
"use client"

import { useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  Badge,
  Button,
  EmptyState,
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
import { RiHistoryLine } from "@remixicon/react"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { describeDuration } from "@/lib/jobs-format"
import { formatDateTime } from "./plan-format"

export type CronRunTrigger = "VERCEL_CRON" | "WORKER" | "MANUAL"
export type CronRunStatus = "RUNNING" | "SUCCESS" | "PARTIAL" | "FAILED"

/** One per-step breakdown entry (plan §3.6: `{ processed, sent,
    failed, skipped, errors }`). `error` is accepted alongside
    `errors` — the writer may store a single error string per step. */
export type CronRunStep = {
  processed?: number
  sent?: number
  failed?: number
  skipped?: number
  errors?: string[] | string | null
  error?: string | null
}

/** One cron run as the client sees it: the plan §3.6 `CronRun` row
    with dates serialised to ISO strings (server → client props). */
export type CronRunRow = {
  id: string
  jobName: string
  trigger: CronRunTrigger
  triggeredById: string | null
  status: CronRunStatus
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  steps: Record<string, CronRunStep> | null
  createdAt: string
}

/** The documented `listCronRuns` envelope (plan §3.6). */
export type CronRunsPage = {
  runs: CronRunRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export type CronRunsFilters = {
  status?: CronRunStatus
  trigger?: CronRunTrigger
  page?: number
  perPage?: number
  jobName?: string
}

type Props = {
  initialData: CronRunsPage
  filters: CronRunsFilters
}

const STATUS_VALUES: CronRunStatus[] = [
  "RUNNING",
  "SUCCESS",
  "PARTIAL",
  "FAILED",
]

const STATUS_LABEL_KEYS: Record<CronRunStatus, string> = {
  RUNNING: "cronStatusRunning",
  SUCCESS: "cronStatusSuccess",
  PARTIAL: "cronStatusPartial",
  FAILED: "cronStatusFailed",
}

const TRIGGER_VALUES: CronRunTrigger[] = ["VERCEL_CRON", "WORKER", "MANUAL"]

const TRIGGER_LABEL_KEYS: Record<CronRunTrigger, string> = {
  VERCEL_CRON: "triggerVercelCron",
  WORKER: "triggerWorker",
  MANUAL: "triggerManual",
}

const STEP_LABEL_KEYS: Record<string, string> = {
  outbox: "stepOutbox",
  rescore: "stepRescore",
  digest: "stepDigest",
  expiry: "stepExpiry",
  reconcile: "stepReconcile",
}

function stepLabel(
  t: (key: string, vars?: Record<string, string | number>) => string,
  name: string
): string {
  const key = STEP_LABEL_KEYS[name]
  return key ? t(key) : t("stepUnknown", { name })
}

function stepError(step: CronRunStep): string | null {
  if (typeof step.error === "string" && step.error !== "") return step.error
  if (typeof step.errors === "string" && step.errors !== "") return step.errors
  if (Array.isArray(step.errors) && step.errors.length > 0)
    return step.errors.join("; ")
  return null
}

function CronRunSteps({ run }: { run: CronRunRow }) {
  const { t } = useTranslation("jobs")
  const [expanded, setExpanded] = useState(false)
  const entries = run.steps ? Object.entries(run.steps) : []

  if (entries.length === 0) return <span>—</span>

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? t("hideSteps") : t("showSteps")}
      </Button>
      {expanded && (
        <div className="flex flex-col gap-2 rounded-md border p-3">
          {entries.map(([name, step]) => {
            const error = stepError(step)
            return (
              <div key={name} className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{stepLabel(t, name)}</span>
                <span className="text-muted-foreground">
                  {[
                    t("stepsProcessed", { count: step.processed ?? 0 }),
                    t("stepsSent", { count: step.sent ?? 0 }),
                    t("stepsFailed", { count: step.failed ?? 0 }),
                    t("stepsSkipped", { count: step.skipped ?? 0 }),
                  ].join(" · ")}
                </span>
                {error && (
                  <span className="text-destructive">
                    {t("stepsError", { error })}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function JobsCronRunsTable({ initialData, filters }: Props) {
  const { t } = useTranslation("jobs")
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const list = initialData

  const pageCount = Math.max(1, list.totalPages)
  const from = list.total === 0 ? 0 : (list.page - 1) * list.perPage + 1
  const to = Math.min(list.total, list.page * list.perPage)

  function pushParams(next: URLSearchParams) {
    const text = next.toString()
    router.push(text ? `${pathname}?${text}` : pathname)
  }

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams.toString())
    if (value === null || value === "") {
      next.delete(key)
    } else {
      next.set(key, value)
    }
    next.delete("cronPage")
    pushParams(next)
  }

  function setPage(page: number) {
    const next = new URLSearchParams(searchParams.toString())
    next.set("cronPage", String(page))
    pushParams(next)
  }

  function clearFilters() {
    const next = new URLSearchParams(searchParams.toString())
    next.delete("cronStatus")
    next.delete("cronTrigger")
    next.delete("cronPage")
    pushParams(next)
  }

  const hasFilters = Boolean(filters.status || filters.trigger)

  function durationLabel(ms: number | null): string {
    const parts = describeDuration(ms)
    if (!parts) return "—"
    return parts.unit === "ms"
      ? t("durationMs", { ms: parts.value })
      : t("durationSeconds", { seconds: parts.value })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="jobs-cron-status-filter">
            {t("cronStatusFilterLabel")}
          </Label>
          <Select
            value={filters.status ?? "all"}
            onValueChange={(value) =>
              setParam("cronStatus", value === "all" ? null : value)
            }
          >
            <SelectTrigger id="jobs-cron-status-filter" className="h-9 w-52">
              <SelectValue placeholder={t("cronStatusAll")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("cronStatusAll")}</SelectItem>
              {STATUS_VALUES.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(STATUS_LABEL_KEYS[value])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="jobs-cron-trigger-filter">
            {t("cronTriggerFilterLabel")}
          </Label>
          <Select
            value={filters.trigger ?? "all"}
            onValueChange={(value) =>
              setParam("cronTrigger", value === "all" ? null : value)
            }
          >
            <SelectTrigger id="jobs-cron-trigger-filter" className="h-9 w-52">
              <SelectValue placeholder={t("cronTriggerAll")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("cronTriggerAll")}</SelectItem>
              {TRIGGER_VALUES.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(TRIGGER_LABEL_KEYS[value])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            {t("clearFilters")}
          </Button>
        )}
      </div>

      {list.total === 0 ? (
        <EmptyState
          icon={RiHistoryLine}
          title={t("noCronRunsTitle")}
          description={t("noCronRunsDescription")}
        />
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colJob")}</TableHead>
                  <TableHead>{t("colTrigger")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead>{t("colStarted")}</TableHead>
                  <TableHead>{t("colFinished")}</TableHead>
                  <TableHead>{t("colDuration")}</TableHead>
                  <TableHead>{t("colSteps")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      {run.jobName === "EMAIL_OUTBOX"
                        ? t("jobEmailOutbox")
                        : run.jobName}
                    </TableCell>
                    <TableCell>
                      <p>{t(TRIGGER_LABEL_KEYS[run.trigger])}</p>
                      {run.trigger === "MANUAL" && run.triggeredById && (
                        <p className="text-sm text-muted-foreground">
                          {t("triggeredBy", { name: run.triggeredById })}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          run.status === "FAILED"
                            ? "destructive"
                            : run.status === "SUCCESS"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {t(STATUS_LABEL_KEYS[run.status])}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {formatDateTime(locale, run.startedAt)}
                    </TableCell>
                    <TableCell>
                      {run.finishedAt
                        ? formatDateTime(locale, run.finishedAt)
                        : t("notFinished")}
                    </TableCell>
                    <TableCell>{durationLabel(run.durationMs)}</TableCell>
                    <TableCell>
                      <CronRunSteps run={run} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{t("showing", { from, to, total: list.total })}</span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={list.page <= 1}
                onClick={() => setPage(list.page - 1)}
              >
                {t("previous")}
              </Button>
              <span className="self-center">
                {t("pageOf", { page: list.page, totalPages: pageCount })}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={list.page >= pageCount}
                onClick={() => setPage(list.page + 1)}
              >
                {t("next")}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
