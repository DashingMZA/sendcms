"use client"

import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { formatDistanceToNow } from "date-fns"
import {
  useEmailJobs,
  type EmailJobListParams,
  type EmailJobListResult,
} from "@/lib/queries/email-jobs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const TABS: { key: "all" | "PENDING" | "SENT" | "FAILED"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "PENDING", label: "Pending" },
  { key: "SENT", label: "Sent" },
  { key: "FAILED", label: "Failed" },
]

const STATUS_BADGE: Record<
  string,
  {
    label: string
    variant: "default" | "secondary" | "destructive" | "outline"
  }
> = {
  PENDING: { label: "Pending", variant: "secondary" },
  SENDING: { label: "Sending", variant: "secondary" },
  SENT: { label: "Sent", variant: "default" },
  FAILED: { label: "Failed", variant: "destructive" },
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

  const { data } = useEmailJobs(params, initialData)
  const list = data ?? initialData

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
        {TABS.map(({ key, label }) => {
          const count =
            key === "all"
              ? list.counts.all
              : list.counts[key.toLowerCase() as "pending" | "sent" | "failed"]
          return (
            <Button
              key={key}
              variant={tab === key ? "default" : "ghost"}
              size="sm"
              onClick={() => setParam("status", key === "all" ? null : key)}
            >
              {label}
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
          <Label htmlFor="jobs-form-filter">Form</Label>
          <Select
            value={params.formId ?? "all"}
            onValueChange={(value) =>
              setParam("formId", value === "all" ? null : value)
            }
          >
            <SelectTrigger id="jobs-form-filter" className="h-9 w-48">
              <SelectValue placeholder="All forms" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All forms</SelectItem>
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
              <TableHead>To</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Form</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-12 text-center">
                  <p className="font-medium">No notification emails yet</p>
                  <p className="text-sm text-muted-foreground">
                    {tab !== "all"
                      ? "Try a different tab."
                      : "Emails sent for new submissions will show up here."}
                  </p>
                </TableCell>
              </TableRow>
            )}
            {list.items.map((job) => {
              const badge = STATUS_BADGE[job.status] ?? {
                label: job.status,
                variant: "outline" as const,
              }
              return (
                <TableRow key={job.id}>
                  <TableCell className="font-medium">{job.to}</TableCell>
                  <TableCell className="max-w-64 truncate">
                    {job.subject}
                  </TableCell>
                  <TableCell>{job.formName ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </TableCell>
                  <TableCell>{job.attempts}</TableCell>
                  <TableCell>
                    {formatDistanceToNow(new Date(job.createdAt), {
                      addSuffix: true,
                    })}
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-sm text-muted-foreground">
                    {job.lastError ?? "—"}
                    {job.providerMessageId && (
                      <span className="block font-mono text-xs">
                        {job.providerMessageId}
                      </span>
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
          Showing {from}–{to} of {list.total} email(s)
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={list.page <= 1}
            onClick={() => setPage(list.page - 1)}
          >
            Previous
          </Button>
          <span className="self-center">
            Page {list.page} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={list.page >= pageCount}
            onClick={() => setPage(list.page + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}
