"use client"

import { useState } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { formatDistanceToNow } from "date-fns"
import {
  type InboxListParams,
  type InboxListResult,
  useBulkUpdateSubmissions,
  useDeleteSubmission,
  useInbox,
  useUpdateSubmissionStatus,
} from "@sendcms/inbox/queries"
import type { InboxActionInput, InboxTabInput } from "@sendcms/inbox/validators"
import { previewSubmissionText } from "@sendcms/shared"

import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
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

import { InboxSearchInput } from "./inbox-search-input"
import { SubmissionStatusBadge } from "./submission-status-badge"

import { MoreHorizontal, Trash2 } from "lucide-react"

const TABS: { key: InboxTabInput; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "read", label: "Read" },
  { key: "starred", label: "Starred" },
  { key: "archived", label: "Archived" },
  { key: "spam", label: "Spam" },
]

type Props = {
  initialData: InboxListResult
  params: InboxListParams
  forms: { id: string; name: string }[]
  domains: { domain: string }[]
}

export function InboxTable({ initialData, params, forms, domains }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const { data } = useInbox(params, initialData)
  const list = data ?? initialData
  const updateStatus = useUpdateSubmissionStatus()
  const deleteSubmission = useDeleteSubmission()
  const bulkUpdate = useBulkUpdateSubmissions()

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const tab = params.tab ?? "all"
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

  function clearFilters() {
    const next = new URLSearchParams()
    if (tab !== "all") next.set("tab", tab)
    pushParams(next)
  }

  const hasFilters = Boolean(
    params.formId ||
    params.originDomain ||
    params.search ||
    params.from ||
    params.to
  )

  async function runAction(id: string, action: InboxActionInput) {
    try {
      await updateStatus.mutateAsync({ id, action })
    } catch {
      toast.error("Could not update the submission.")
    }
  }

  async function runBulk(action: InboxActionInput) {
    if (selectedIds.size === 0) return
    try {
      const result = await bulkUpdate.mutateAsync({
        ids: [...selectedIds],
        action,
      })
      toast.success(
        `${result.updated} submission(s) updated${result.skipped ? `, ${result.skipped} skipped` : ""}.`
      )
      setSelectedIds(new Set())
    } catch {
      toast.error("Could not update the submissions.")
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    try {
      await deleteSubmission.mutateAsync(deleteTarget)
      toast.success("Submission deleted.")
      setSelectedIds((prev) => {
        const next = new Set(prev)
        next.delete(deleteTarget)
        return next
      })
    } catch {
      toast.error("Could not delete the submission.")
    } finally {
      setDeleteTarget(null)
    }
  }

  async function bulkDelete() {
    if (selectedIds.size === 0) return
    const ids = [...selectedIds]
    try {
      for (const id of ids) {
        await deleteSubmission.mutateAsync(id)
      }
      toast.success(`${ids.length} submission(s) deleted.`)
      setSelectedIds(new Set())
    } catch {
      toast.error("Could not delete the submissions.")
    }
  }

  function toggleAll(checked: boolean) {
    setSelectedIds(
      checked ? new Set(list.items.map((item) => item.id)) : new Set()
    )
  }

  function toggleOne(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1">
        {TABS.map(({ key, label }) => (
          <Button
            key={key}
            variant={tab === key ? "default" : "ghost"}
            size="sm"
            onClick={() => setParam("tab", key === "all" ? null : key)}
          >
            {label}
            <Badge
              variant={tab === key ? "secondary" : "outline"}
              className="ml-1"
            >
              {list.counts[key]}
            </Badge>
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <InboxSearchInput defaultValue={params.search ?? ""} />
        <div className="space-y-1">
          <Label htmlFor="inbox-form-filter">Form</Label>
          <Select
            value={params.formId ?? "all"}
            onValueChange={(value) =>
              setParam("formId", value === "all" ? null : value)
            }
          >
            <SelectTrigger id="inbox-form-filter" className="h-9 w-48">
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
        <div className="space-y-1">
          <Label htmlFor="inbox-domain-filter">Domain</Label>
          <Select
            value={params.originDomain ?? "all"}
            onValueChange={(value) =>
              setParam("originDomain", value === "all" ? null : value)
            }
          >
            <SelectTrigger id="inbox-domain-filter" className="h-9 w-48">
              <SelectValue placeholder="All domains" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All domains</SelectItem>
              {domains.map((domain) => (
                <SelectItem key={domain.domain} value={domain.domain}>
                  {domain.domain}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="inbox-from">From</Label>
          <Input
            id="inbox-from"
            type="date"
            value={params.from ?? ""}
            onChange={(e) => setParam("from", e.target.value || null)}
            className="h-9 w-40"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="inbox-to">To</Label>
          <Input
            id="inbox-to"
            type="date"
            value={params.to ?? ""}
            onChange={(e) => setParam("to", e.target.value || null)}
            className="h-9 w-40"
          />
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </div>

      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2">
          <span className="text-sm font-medium">
            {selectedIds.size} selected
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runBulk("read")}
            disabled={bulkUpdate.isPending}
          >
            Mark read
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runBulk("archive")}
            disabled={bulkUpdate.isPending}
          >
            Archive
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runBulk("spam")}
            disabled={bulkUpdate.isPending}
          >
            Mark spam
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={bulkDelete}
            disabled={deleteSubmission.isPending}
          >
            <Trash2 className="size-3.5" /> Delete
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear
          </Button>
        </div>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={
                    list.items.length > 0 &&
                    selectedIds.size === list.items.length
                  }
                  onCheckedChange={(checked) => toggleAll(checked === true)}
                  aria-label="Select all on this page"
                />
              </TableHead>
              <TableHead>Sender</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Form</TableHead>
              <TableHead>Origin</TableHead>
              <TableHead>Received</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-12 text-center">
                  <p className="font-medium">No submissions yet</p>
                  <p className="text-sm text-muted-foreground">
                    {hasFilters || tab !== "all"
                      ? "Try a different tab or clear the filters."
                      : "Submissions from your forms will show up here."}
                  </p>
                </TableCell>
              </TableRow>
            )}
            {list.items.map((item) => (
              <TableRow
                key={item.id}
                className="cursor-pointer"
                onClick={() => router.push(`/dashboard/inbox/${item.id}`)}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selectedIds.has(item.id)}
                    onCheckedChange={(checked) =>
                      toggleOne(item.id, checked === true)
                    }
                    aria-label={`Select submission from ${item.sender.name ?? item.sender.email ?? "unknown sender"}`}
                  />
                </TableCell>
                <TableCell>
                  <p className="font-medium">
                    {item.sender.name ?? item.sender.email ?? "Unknown"}
                  </p>
                  {item.sender.name && item.sender.email && (
                    <p className="text-sm text-muted-foreground">
                      {item.sender.email}
                    </p>
                  )}
                </TableCell>
                <TableCell className="max-w-64 truncate">
                  {previewSubmissionText(item.data)}
                </TableCell>
                <TableCell>{item.formName}</TableCell>
                <TableCell>{item.originDomain}</TableCell>
                <TableCell>
                  {formatDistanceToNow(new Date(item.createdAt), {
                    addSuffix: true,
                  })}
                </TableCell>
                <TableCell>
                  <SubmissionStatusBadge status={item.status} />
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="size-8 p-0">
                        <MoreHorizontal className="size-4" />
                        <span className="sr-only">Actions</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() =>
                          router.push(`/dashboard/inbox/${item.id}`)
                        }
                      >
                        View
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {item.status === "NEW" && (
                        <DropdownMenuItem
                          onClick={() => runAction(item.id, "read")}
                        >
                          Mark as read
                        </DropdownMenuItem>
                      )}
                      {(item.status === "READ" ||
                        item.status === "STARRED") && (
                        <DropdownMenuItem
                          onClick={() => runAction(item.id, "unread")}
                        >
                          Mark as unread
                        </DropdownMenuItem>
                      )}
                      {item.status !== "STARRED" &&
                        item.status !== "ARCHIVED" &&
                        item.status !== "SPAM" && (
                          <DropdownMenuItem
                            onClick={() => runAction(item.id, "star")}
                          >
                            Star
                          </DropdownMenuItem>
                        )}
                      {item.status === "STARRED" && (
                        <DropdownMenuItem
                          onClick={() => runAction(item.id, "unstar")}
                        >
                          Unstar
                        </DropdownMenuItem>
                      )}
                      {item.status !== "ARCHIVED" && item.status !== "SPAM" && (
                        <DropdownMenuItem
                          onClick={() => runAction(item.id, "archive")}
                        >
                          Archive
                        </DropdownMenuItem>
                      )}
                      {item.status === "ARCHIVED" && (
                        <DropdownMenuItem
                          onClick={() => runAction(item.id, "restore")}
                        >
                          Restore
                        </DropdownMenuItem>
                      )}
                      {item.status !== "SPAM" && item.status !== "ARCHIVED" && (
                        <DropdownMenuItem
                          onClick={() => runAction(item.id, "spam")}
                        >
                          Mark as spam
                        </DropdownMenuItem>
                      )}
                      {item.status === "SPAM" && (
                        <DropdownMenuItem
                          onClick={() => runAction(item.id, "not-spam")}
                        >
                          Not spam
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => setDeleteTarget(item.id)}
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          Showing {from}–{to} of {list.total} submission(s)
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

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this submission?</DialogTitle>
            <DialogDescription>
              This permanently deletes the submission and its history. This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
