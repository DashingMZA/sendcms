"use client"

import { useState } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { formatRelativeDate } from "@sendcms/i18n"
import { toast } from "sonner"
import {
  type EmailJobListParams,
  type EmailJobListResult,
  useEmailJobs,
  useRequeueEmailJob,
} from "@sendcms/notifications/queries"
import { ApiClientError } from "@sendcms/shared"

import {
  Badge,
  Button,
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
} from "@/components/dashboard/translation-provider"

const TABS: {
  key: "all" | "PENDING" | "SENDING" | "SENT" | "FAILED"
  labelKey: string
}[] = [
  { key: "all", labelKey: "tabAll" },
  { key: "PENDING", labelKey: "tabPending" },
  // EML-094: SENDING is a real state, not a transient — it gets its
  // own tab so a stuck job is filterable, not just visible in All.
  { key: "SENDING", labelKey: "tabSending" },
  { key: "SENT", labelKey: "tabSent" },
  { key: "FAILED", labelKey: "tabFailed" },
]

/** Translation key (notifications domain) for each email-job status
    label. A status with no key here renders its raw status value. */
const STATUS_LABEL_KEYS: Record<string, string> = {
  PENDING: "statusPending",
  SENDING: "statusSending",
  SENT: "statusSent",
  FAILED: "statusFailed",
}

const STATUS_BADGE: Record<
  string,
  {
    variant: "default" | "secondary" | "destructive" | "outline"
  }
> = {
  PENDING: { variant: "secondary" },
  SENDING: { variant: "secondary" },
  SENT: { variant: "default" },
  FAILED: { variant: "destructive" },
}

type Props = {
  initialData: EmailJobListResult
  params: EmailJobListParams
  forms: { id: string; name: string }[]
}

export function EmailJobsTable({ initialData, params, forms }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { t } = useTranslation("notifications")
  const locale = useLocale()

  const { data } = useEmailJobs(params, initialData)
  const list = data ?? initialData
  const requeue = useRequeueEmailJob()
  const [requeueingId, setRequeueingId] = useState<string | null>(null)

  async function onRequeue(jobId: string) {
    setRequeueingId(jobId)
    try {
      await requeue.mutateAsync(jobId)
      toast.success(t("requeueSuccess"))
    } catch (err) {
      // The server's message names the reason (e.g. a SENDING job
      // still inside its lease); the generic string is only the
      // fallback for non-API errors.
      toast.error(
        err instanceof ApiClientError ? err.message : t("requeueFailed")
      )
    } finally {
      setRequeueingId(null)
    }
  }

  const tab = params.status ?? "all"
  const pageCount = Math.max(1, Math.ceil(list.total / list.pageSize))
  const from = list.total === 0 ? 0 : (list.page - 1) * list.pageSize + 1
  const to = Math.min(list.total, list.page * list.pageSize)

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
    next.delete("page")
    pushParams(next)
  }

  function setPage(page: number) {
    const next = new URLSearchParams(searchParams.toString())
    next.set("page", String(page))
    pushParams(next)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1">
        {TABS.map(({ key, labelKey }) => {
          const count =
            key === "all"
              ? list.counts.all
              : list.counts[
                  key.toLowerCase() as "pending" | "sending" | "sent" | "failed"
                ]
          return (
            <Button
              key={key}
              variant={tab === key ? "default" : "ghost"}
              size="sm"
              onClick={() => setParam("status", key === "all" ? null : key)}
            >
              {t(labelKey)}
              <Badge
                variant={tab === key ? "secondary" : "outline"}
                className="ml-1"
              >
                {count}
              </Badge>
            </Button>
          )
        })}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="jobs-form-filter">{t("formLabel")}</Label>
          <Select
            value={params.formId ?? "all"}
            onValueChange={(value) =>
              setParam("formId", value === "all" ? null : value)
            }
          >
            <SelectTrigger id="jobs-form-filter" className="h-9 w-48">
              <SelectValue placeholder={t("allForms")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allForms")}</SelectItem>
              {forms.map((form) => (
                <SelectItem key={form.id} value={form.id}>
                  {form.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colTo")}</TableHead>
              <TableHead>{t("colSubject")}</TableHead>
              <TableHead>{t("colForm")}</TableHead>
              <TableHead>{t("colStatus")}</TableHead>
              <TableHead>{t("colAttempts")}</TableHead>
              <TableHead>{t("colCreated")}</TableHead>
              <TableHead>{t("colClaimAge")}</TableHead>
              <TableHead>{t("colLastError")}</TableHead>
              <TableHead>{t("colActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-12 text-center">
                  <p className="font-medium">{t("emptyTitle")}</p>
                  <p className="text-sm text-muted-foreground">
                    {tab !== "all" ? t("emptyFiltered") : t("emptyDescription")}
                  </p>
                </TableCell>
              </TableRow>
            )}
            {list.items.map((job) => {
              const badge = STATUS_BADGE[job.status] ?? {
                variant: "outline" as const,
              }
              const labelKey = STATUS_LABEL_KEYS[job.status]
              return (
                <TableRow key={job.id}>
                  <TableCell className="font-medium">{job.to}</TableCell>
                  <TableCell className="max-w-64 truncate">
                    {job.subject}
                  </TableCell>
                  <TableCell>{job.formName ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={badge.variant}>
                      {labelKey ? t(labelKey) : job.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{job.attempts}</TableCell>
                  <TableCell>
                    {formatRelativeDate(locale, job.createdAt)}
                  </TableCell>
                  <TableCell>
                    {/* EML-094: claim age is shown for SENDING rows
                        (time since the claim, from `updatedAt`); every
                        other status has no claim to age. */}
                    {job.status === "SENDING" && job.claimAgeMinutes !== null
                      ? formatRelativeDate(locale, job.updatedAt)
                      : "—"}
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-sm text-muted-foreground">
                    {job.lastError ?? "—"}
                    {job.providerMessageId && (
                      <span className="block font-mono text-xs">
                        {job.providerMessageId}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {/* EML-094/095: FAILED jobs, and SENDING jobs
                        stuck past the lease, can be requeued from
                        here. `canRequeue` is computed server-side. */}
                    {job.canRequeue && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={requeueingId === job.id}
                        onClick={() => onRequeue(job.id)}
                      >
                        {requeueingId === job.id
                          ? t("requeuing")
                          : t("requeue")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {list.total === 1
            ? t("showingEmailsOne", { from, to, total: list.total })
            : t("showingEmailsOther", { from, to, total: list.total })}
        </span>
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
    </div>
  )
}
