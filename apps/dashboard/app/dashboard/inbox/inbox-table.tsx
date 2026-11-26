"use client"

import { useState } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { formatRelativeDate } from "@sendcms/i18n"
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
  EmptyState,
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
  Tabs,
  TabsList,
  TabsTrigger,
} from "@sendcms/ui"

import { RiDeleteBinLine, RiInboxLine, RiMoreLine } from "@remixicon/react"

import { InboxSearchInput } from "./inbox-search-input"
import {
  SUBMISSION_STATUS_LABEL_KEYS,
  SubmissionStatusBadge,
} from "./submission-status-badge"
import {
  useLocale,
  useTranslation,
} from "@/components/dashboard/translation-provider"

const TABS: { key: InboxTabInput; labelKey: string }[] = [
  { key: "all", labelKey: "tabAll" },
  { key: "unread", labelKey: "tabUnread" },
  { key: "read", labelKey: "tabRead" },
  { key: "starred", labelKey: "tabStarred" },
  { key: "archived", labelKey: "tabArchived" },
  { key: "spam", labelKey: "tabSpam" },
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
  const { t } = useTranslation("inbox")
  const locale = useLocale()

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
      toast.error(t("updateFailed"))
    }
  }

  async function runBulk(action: InboxActionInput) {
    if (selectedIds.size === 0) return
    try {
      const result = await bulkUpdate.mutateAsync({
        ids: [...selectedIds],
        action,
      })
      if (result.skipped) {
        toast.success(
          result.updated === 1
            ? t("bulkUpdatedSkippedOne", {
                updated: result.updated,
                skipped: result.skipped,
              })
            : t("bulkUpdatedSkippedOther", {
                updated: result.updated,
                skipped: result.skipped,
              })
        )
      } else {
        toast.success(
          result.updated === 1
            ? t("bulkUpdatedOne", { updated: result.updated })
            : t("bulkUpdatedOther", { updated: result.updated })
        )
      }
      setSelectedIds(new Set())
    } catch {
      toast.error(t("updateFailedMultiple"))
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    try {
      await deleteSubmission.mutateAsync(deleteTarget)
      toast.success(t("deleteSuccess"))
      setSelectedIds((prev) => {
        const next = new Set(prev)
        next.delete(deleteTarget)
        return next
      })
    } catch {
      toast.error(t("deleteFailed"))
    } finally {
      setDeleteTarget(null)
    }
  }

  // Bulk delete is N single DELETEs (there is no bulk-delete endpoint —
  // the bulk route only handles status actions). A failure mid-loop must
  // not hide what already happened: delete each id on its own, count the
  // outcomes, and report the exact counts. The ids that failed stay
  // selected (and stay listed) so the user can see exactly which
  // submissions were not deleted and retry them (DSH-205).
  async function bulkDelete() {
    if (selectedIds.size === 0) return
    const ids = [...selectedIds]
    const failedIds: string[] = []
    let deleted = 0
    for (const id of ids) {
      try {
        await deleteSubmission.mutateAsync(id)
        deleted += 1
      } catch {
        failedIds.push(id)
      }
    }
    if (deleted > 0) {
      toast.success(
        deleted === 1
          ? t("bulkDeletedOne", { count: deleted })
          : t("bulkDeletedOther", { count: deleted })
      )
    }
    if (failedIds.length > 0) {
      toast.error(t("deleteFailedMultiple"))
    }
    setSelectedIds(new Set(failedIds))
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
      <Tabs
        value={tab}
        onValueChange={(value) =>
          setParam("tab", value === "all" ? null : value)
        }
      >
        <TabsList className="h-auto flex-wrap justify-start">
          {TABS.map(({ key, labelKey }) => (
            <TabsTrigger key={key} value={key}>
              {t(labelKey)}
              <Badge
                variant={tab === key ? "secondary" : "outline"}
                className="ml-1"
              >
                {list.counts[key]}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap items-end gap-3">
        <InboxSearchInput defaultValue={params.search ?? ""} />
        <div className="space-y-1">
          <Label htmlFor="inbox-form-filter">{t("formLabel")}</Label>
          <Select
            value={params.formId ?? "all"}
            onValueChange={(value) =>
              setParam("formId", value === "all" ? null : value)
            }
          >
            <SelectTrigger id="inbox-form-filter" className="h-9 w-48">
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
        <div className="space-y-1">
          <Label htmlFor="inbox-domain-filter">{t("domainLabel")}</Label>
          <Select
            value={params.originDomain ?? "all"}
            onValueChange={(value) =>
              setParam("originDomain", value === "all" ? null : value)
            }
          >
            <SelectTrigger id="inbox-domain-filter" className="h-9 w-48">
              <SelectValue placeholder={t("allDomains")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allDomains")}</SelectItem>
              {domains.map((domain) => (
                <SelectItem key={domain.domain} value={domain.domain}>
                  {domain.domain}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="inbox-from">{t("fromLabel")}</Label>
          <Input
            id="inbox-from"
            type="date"
            value={params.from ?? ""}
            onChange={(e) => setParam("from", e.target.value || null)}
            className="h-9 w-40"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="inbox-to">{t("toLabel")}</Label>
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
            {t("clearFilters")}
          </Button>
        )}
      </div>

      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2">
          <span className="text-sm font-medium">
            {t("selectedCount", { count: selectedIds.size })}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runBulk("read")}
            disabled={bulkUpdate.isPending}
          >
            {t("markRead")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runBulk("archive")}
            disabled={bulkUpdate.isPending}
          >
            {t("archive")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runBulk("spam")}
            disabled={bulkUpdate.isPending}
          >
            {t("markAsSpam")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={bulkDelete}
            disabled={deleteSubmission.isPending}
          >
            <RiDeleteBinLine className="size-3.5" /> {t("delete")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedIds(new Set())}
          >
            {t("clear")}
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
                  aria-label={t("selectAllOnPage")}
                />
              </TableHead>
              <TableHead>{t("colSender")}</TableHead>
              <TableHead>{t("colMessage")}</TableHead>
              <TableHead className="hidden md:table-cell">
                {t("colForm")}
              </TableHead>
              <TableHead className="hidden md:table-cell">
                {t("colOrigin")}
              </TableHead>
              <TableHead>{t("colReceived")}</TableHead>
              <TableHead>{t("colStatus")}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={8}>
                  <EmptyState
                    icon={RiInboxLine}
                    title={t("emptyTitle")}
                    description={
                      hasFilters || tab !== "all"
                        ? t("emptyFiltered")
                        : t("emptyDescription")
                    }
                  />
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
                    aria-label={t("selectSubmission", {
                      sender:
                        item.sender.name ?? item.sender.email ?? t("unknown"),
                    })}
                  />
                </TableCell>
                <TableCell>
                  <p className="font-medium">
                    {item.sender.name ?? item.sender.email ?? t("unknown")}
                  </p>
                  {item.sender.name && item.sender.email && (
                    <p className="text-sm text-muted-foreground">
                      <bdi dir="ltr">{item.sender.email}</bdi>
                    </p>
                  )}
                </TableCell>
                <TableCell className="max-w-64 truncate">
                  {previewSubmissionText(item.data)}
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  {item.formName}
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <bdi dir="ltr">{item.originDomain}</bdi>
                </TableCell>
                <TableCell>
                  {formatRelativeDate(locale, item.createdAt)}
                </TableCell>
                <TableCell>
                  <SubmissionStatusBadge
                    status={item.status}
                    label={t(SUBMISSION_STATUS_LABEL_KEYS[item.status])}
                  />
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="size-8 p-0">
                        <RiMoreLine className="size-4" />
                        <span className="sr-only">{t("actions")}</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() =>
                          router.push(`/dashboard/inbox/${item.id}`)
                        }
                      >
                        {t("view")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {item.status === "NEW" && (
                        <DropdownMenuItem
                          onClick={() => runAction(item.id, "read")}
                        >
                          {t("markAsRead")}
                        </DropdownMenuItem>
                      )}
                      {(item.status === "READ" ||
                        item.status === "STARRED") && (
                        <DropdownMenuItem
                          onClick={() => runAction(item.id, "unread")}
                        >
                          {t("markAsUnread")}
                        </DropdownMenuItem>
                      )}
                      {item.status !== "STARRED" &&
                        item.status !== "ARCHIVED" &&
                        item.status !== "SPAM" && (
                          <DropdownMenuItem
                            onClick={() => runAction(item.id, "star")}
                          >
                            {t("star")}
                          </DropdownMenuItem>
                        )}
                      {item.status === "STARRED" && (
                        <DropdownMenuItem
                          onClick={() => runAction(item.id, "unstar")}
                        >
                          {t("unstar")}
                        </DropdownMenuItem>
                      )}
                      {item.status !== "ARCHIVED" && item.status !== "SPAM" && (
                        <DropdownMenuItem
                          onClick={() => runAction(item.id, "archive")}
                        >
                          {t("archive")}
                        </DropdownMenuItem>
                      )}
                      {item.status === "ARCHIVED" && (
                        <DropdownMenuItem
                          onClick={() => runAction(item.id, "restore")}
                        >
                          {t("restore")}
                        </DropdownMenuItem>
                      )}
                      {item.status !== "SPAM" && item.status !== "ARCHIVED" && (
                        <DropdownMenuItem
                          onClick={() => runAction(item.id, "spam")}
                        >
                          {t("markAsSpam")}
                        </DropdownMenuItem>
                      )}
                      {item.status === "SPAM" && (
                        <DropdownMenuItem
                          onClick={() => runAction(item.id, "not-spam")}
                        >
                          {t("notSpam")}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => setDeleteTarget(item.id)}
                      >
                        {t("delete")}
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
          {list.total === 1
            ? t("showingResultsOne", { from, to, total: list.total })
            : t("showingResultsOther", { from, to, total: list.total })}
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

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>{t("deleteDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
