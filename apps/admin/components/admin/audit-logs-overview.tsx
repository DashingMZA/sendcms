"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import type { AuditLogRow } from "@sendcms/platform-ops"
import { AUDIT_ACTIONS, AUDIT_RESOURCES } from "./audit-filter-options"
import { useAuditLog, useAuditLogs } from "@sendcms/platform-ops/queries"
import { apiFetch } from "@sendcms/shared"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"
import { downloadJson } from "@/lib/download-json"

type Props = {
  actorRole: PlatformRole | AdminRole
}

type Filters = {
  actorId?: string
  targetUserId?: string
  action?: string
  resourceType?: string
  outcome?: string
  correlationId?: string
  from?: string
  to?: string
}

function toQueryString(filters: Record<string, string | number | undefined>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const query = params.toString()
  return query ? `?${query}` : ""
}

function formatDateTime(value: string | Date | null) {
  if (!value) return "—"
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * The audit log explorer (Phase 7): filterable table, a detail view
 * with the full row, and a JSON export. Reads need VIEW_AUDIT_LOGS;
 * the export button only renders for EXPORT_AUDIT_LOGS holders. The
 * log is append-only — there is no edit or delete anywhere here.
 */
export function AuditLogsOverview({ actorRole }: Props) {
  const { t } = useTranslation("audit-logs")
  const canView = adminCan(actorRole, "VIEW_AUDIT_LOGS")

  if (!canView) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("noPermission")}</p>
        </CardContent>
      </Card>
    )
  }

  return <AuditLogsInner actorRole={actorRole} />
}

function AuditLogsInner({ actorRole }: Props) {
  const { t } = useTranslation("audit-logs")
  const canExport = adminCan(actorRole, "EXPORT_AUDIT_LOGS")

  // Draft filters (the inputs) vs applied filters (the query). The
  // query only re-runs when the admin applies, so typing does not
  // refetch on every keystroke.
  const [draft, setDraft] = useState<Filters>({})
  const [applied, setApplied] = useState<Filters>({})
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { data, isLoading } = useAuditLogs({ ...applied, page, perPage: 20 })
  const logs = data?.logs ?? []
  const totalPages = data?.totalPages ?? 1
  const currentPage = data?.page ?? page

  function applyFilters() {
    setApplied(draft)
    setPage(1)
  }

  function clearFilters() {
    setDraft({})
    setApplied({})
    setPage(1)
  }

  async function exportLogs() {
    setExporting(true)
    try {
      // SRC-109: the export goes through apiFetch, not raw fetch —
      // typed errors + the same auth/timeout handling as every other
      // client call. (A download has no React Query hook; apiFetch
      // is the documented path for it.)
      const body = await apiFetch<unknown>(
        `/api/v1/admin/audit-logs/export${toQueryString(applied)}`
      )
      downloadJson(body, "sendcms-audit-logs.json")
      toast.success(t("exported"))
    } catch {
      toast.error(t("export"))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{t("filtersTitle")}</CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          {canExport && (
            <Button onClick={exportLogs} disabled={exporting}>
              {exporting ? t("exporting") : t("export")}
            </Button>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="audit-actor">{t("actorId")}</Label>
              <Input
                id="audit-actor"
                value={draft.actorId ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, actorId: e.target.value || undefined })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-target">{t("targetUserId")}</Label>
              <Input
                id="audit-target"
                value={draft.targetUserId ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    targetUserId: e.target.value || undefined,
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-action">{t("action")}</Label>
              <Select
                value={draft.action ?? "all"}
                onValueChange={(v) =>
                  setDraft({
                    ...draft,
                    action: v === "all" ? undefined : v,
                  })
                }
              >
                <SelectTrigger id="audit-action">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("all")}</SelectItem>
                  {AUDIT_ACTIONS.map((action) => (
                    <SelectItem key={action} value={action}>
                      {action}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-resource">{t("resourceType")}</Label>
              <Select
                value={draft.resourceType ?? "all"}
                onValueChange={(v) =>
                  setDraft({
                    ...draft,
                    resourceType: v === "all" ? undefined : v,
                  })
                }
              >
                <SelectTrigger id="audit-resource">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("all")}</SelectItem>
                  {AUDIT_RESOURCES.map((resource) => (
                    <SelectItem key={resource} value={resource}>
                      {resource}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-outcome">{t("outcome")}</Label>
              <Select
                value={draft.outcome ?? "all"}
                onValueChange={(v) =>
                  setDraft({
                    ...draft,
                    outcome: v === "all" ? undefined : v,
                  })
                }
              >
                <SelectTrigger id="audit-outcome">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("all")}</SelectItem>
                  <SelectItem value="SUCCESS">{t("outcomeSuccess")}</SelectItem>
                  <SelectItem value="FAILED">{t("outcomeFailed")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-correlation">{t("correlationId")}</Label>
              <Input
                id="audit-correlation"
                value={draft.correlationId ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    correlationId: e.target.value || undefined,
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-from">{t("from")}</Label>
              <Input
                id="audit-from"
                type="datetime-local"
                value={draft.from ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, from: e.target.value || undefined })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-to">{t("to")}</Label>
              <Input
                id="audit-to"
                type="datetime-local"
                value={draft.to ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, to: e.target.value || undefined })
                }
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={applyFilters}>{t("applyFilters")}</Button>
            <Button variant="outline" onClick={clearFilters}>
              {t("clearFilters")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : logs.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("noLogs")}
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colTime")}</TableHead>
                    <TableHead>{t("colActor")}</TableHead>
                    <TableHead>{t("colAction")}</TableHead>
                    <TableHead>{t("colResource")}</TableHead>
                    <TableHead>{t("colOutcome")}</TableHead>
                    <TableHead>{t("colReason")}</TableHead>
                    <TableHead>{t("actionsCol")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatDateTime(log.createdAt)}
                      </TableCell>
                      <TableCell className="max-w-48 truncate text-sm">
                        {log.actor?.name ??
                          log.actor?.email ??
                          t("actorSystem")}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{log.action}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {log.resourceType}
                        <p className="max-w-32 truncate font-mono text-xs text-muted-foreground">
                          {log.resourceId}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            log.outcome === "FAILED"
                              ? "destructive"
                              : "secondary"
                          }
                        >
                          {log.outcome === "FAILED"
                            ? t("outcomeFailed")
                            : t("outcomeSuccess")}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-64 truncate text-sm">
                        {log.reason ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSelectedId(log.id)}
                        >
                          {t("view")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="mt-4 flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {t("pageOf", { page: currentPage, totalPages })}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
              >
                {t("prev")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={currentPage >= totalPages}
              >
                {t("next")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null)
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("detailTitle")}</DialogTitle>
          </DialogHeader>
          {selectedId !== null && <AuditLogDetail id={selectedId} />}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** One audit event, loaded only while the detail dialog is open. */
function AuditLogDetail({ id }: { id: string }) {
  const { t } = useTranslation("audit-logs")
  const { data, isLoading } = useAuditLog(id)

  if (isLoading) return <Skeleton className="h-48 w-full" />
  if (!data) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {t("noLogs")}
      </p>
    )
  }

  const log: AuditLogRow = data
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <p>
          <span className="font-medium">{t("colTime")}: </span>
          {formatDateTime(log.createdAt)}
        </p>
        <p>
          <span className="font-medium">{t("colActor")}: </span>
          {log.actor?.name ?? log.actor?.email ?? t("actorSystem")}
        </p>
        <p>
          <span className="font-medium">{t("colAction")}: </span>
          {log.action}
        </p>
        <p>
          <span className="font-medium">{t("colResource")}: </span>
          {log.resourceType} ·{" "}
          <span className="font-mono text-xs">{log.resourceId}</span>
        </p>
        <p>
          <span className="font-medium">{t("colOutcome")}: </span>
          {log.outcome === "FAILED" ? t("outcomeFailed") : t("outcomeSuccess")}
        </p>
        <p>
          <span className="font-medium">{t("ipAddress")}: </span>
          {log.ipAddress ?? "—"}
        </p>
        <p className="sm:col-span-2">
          <span className="font-medium">{t("reason")}: </span>
          {log.reason ?? "—"}
        </p>
        <p className="sm:col-span-2">
          <span className="font-medium">{t("correlationId")}: </span>
          <span className="font-mono text-xs">{log.correlationId ?? "—"}</span>
        </p>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium">{t("detailJson")}</p>
        <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-4 text-xs">
          {JSON.stringify(log.detail, null, 2)}
        </pre>
      </div>
    </div>
  )
}
