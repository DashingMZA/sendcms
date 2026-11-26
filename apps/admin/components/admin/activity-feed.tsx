// Activity feed (Phase B, plan §3.1): the unified chronological
// feed — audit + subscription + billing + submission events, newest
// first, with shared Tabs for the source filter (All / Users /
// Billing / AI / Support) and shared EmptyState. Read-only: no
// mutations anywhere here.
//
// Shape model is the audit-log explorer: the server page only
// authenticates, this component reads through the api app via React
// Query. Filters are draft/applied (typing does not refetch); the
// tab is URL-as-state, like the trials table. Pagination is cursor
// based — "Load more" fetches the next page for the cursor and
// appends it. An audit row's View button opens the existing
// audit-log detail dialog (useAuditLog); every other row links out
// to its source record.
//
// Bundle boundary: the resource options come from the client-safe
// copy in ./audit-filter-options — never from @sendcms/platform-ops,
// whose barrel re-exports the audit service and would drag `db`
// into the browser bundle.
"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import type { ActivityFeedRow } from "@sendcms/platform-ops"
import { AUDIT_RESOURCES } from "./audit-filter-options"
import {
  useActivityFeed,
  useActivityFeedPage,
  useAuditLog,
  type ActivityFeedFilters,
} from "@sendcms/platform-ops/queries"
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
  EmptyState,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@sendcms/ui"
import { RiHistoryLine } from "@remixicon/react"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDateTime } from "./plan-format"

type Props = {
  actorRole: PlatformRole | AdminRole
}

type ActivityTab = "all" | "users" | "billing" | "ai" | "support"

const TABS: ActivityTab[] = ["all", "users", "billing", "ai", "support"]

type Filters = {
  actorId?: string
  resourceType?: string
  outcome?: string
  from?: string
  to?: string
  q?: string
}

export function ActivityFeed({ actorRole }: Props) {
  const { t } = useTranslation("activity")
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

  return <ActivityFeedInner />
}

function ActivityFeedInner() {
  const { t } = useTranslation("activity")
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const rawTab = searchParams.get("tab")
  const tab: ActivityTab =
    rawTab !== null && (TABS as string[]).includes(rawTab)
      ? (rawTab as ActivityTab)
      : "all"

  // Draft filters (the inputs) vs applied filters (the query). The
  // query only re-runs when the admin applies, so typing does not
  // refetch on every keystroke.
  const [draft, setDraft] = useState<Filters>({})
  const [applied, setApplied] = useState<Filters>({})
  const [selectedAuditId, setSelectedAuditId] = useState<string | null>(null)

  const filters: ActivityFeedFilters = { ...applied, tab, limit: 20 }
  const { data, isLoading } = useActivityFeed(filters)
  const rows = data?.rows ?? []

  // Appended pages from "Load more", reset whenever the first page
  // changes (new filters, new tab, refetch): "adjust state during
  // render" — the query data identity only changes when the page
  // does, so the reset runs exactly once per new first page.
  const [extra, setExtra] = useState<ActivityFeedRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const pageQuery = useActivityFeedPage(filters, cursor)

  const [prevFirstPage, setPrevFirstPage] = useState(data)
  if (prevFirstPage !== data) {
    setPrevFirstPage(data)
    setExtra([])
    setCursor(data?.nextCursor ?? null)
  }

  function applyFilters() {
    setApplied(draft)
  }

  function clearFilters() {
    setDraft({})
    setApplied({})
  }

  function setTab(nextTab: string) {
    if (!(TABS as string[]).includes(nextTab)) return
    const next = new URLSearchParams(searchParams.toString())
    if (nextTab === "all") {
      next.delete("tab")
    } else {
      next.set("tab", nextTab)
    }
    next.delete("cursor")
    const text = next.toString()
    router.push(text ? `${pathname}?${text}` : pathname)
  }

  async function loadMore() {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    try {
      const { data: page } = await pageQuery.refetch()
      if (page) {
        setExtra((prev) => [...prev, ...page.rows])
        setCursor(page.nextCursor)
      }
    } finally {
      setLoadingMore(false)
    }
  }

  const allRows = [...rows, ...extra]
  const hasFilters = Object.keys(applied).length > 0

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="h-auto flex-wrap justify-start">
        <TabsTrigger value="all">{t("tabAll")}</TabsTrigger>
        <TabsTrigger value="users">{t("tabUsers")}</TabsTrigger>
        <TabsTrigger value="billing">{t("tabBilling")}</TabsTrigger>
        <TabsTrigger value="ai">{t("tabAi")}</TabsTrigger>
        <TabsTrigger value="support">{t("tabSupport")}</TabsTrigger>
      </TabsList>

      <TabsContent value={tab} className="mt-6 flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t("filtersTitle")}</CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="activity-actor">{t("actorId")}</Label>
                <Input
                  id="activity-actor"
                  value={draft.actorId ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      actorId: e.target.value || undefined,
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="activity-resource">{t("resourceType")}</Label>
                <Select
                  value={draft.resourceType ?? "all"}
                  onValueChange={(v) =>
                    setDraft({
                      ...draft,
                      resourceType: v === "all" ? undefined : v,
                    })
                  }
                >
                  <SelectTrigger id="activity-resource">
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
                <Label htmlFor="activity-outcome">{t("outcome")}</Label>
                <Select
                  value={draft.outcome ?? "all"}
                  onValueChange={(v) =>
                    setDraft({
                      ...draft,
                      outcome: v === "all" ? undefined : v,
                    })
                  }
                >
                  <SelectTrigger id="activity-outcome">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("all")}</SelectItem>
                    <SelectItem value="SUCCESS">
                      {t("outcomeSuccess")}
                    </SelectItem>
                    <SelectItem value="FAILED">{t("outcomeFailed")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="activity-search">{t("search")}</Label>
                <Input
                  id="activity-search"
                  placeholder={t("searchPlaceholder")}
                  value={draft.q ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, q: e.target.value || undefined })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="activity-from">{t("from")}</Label>
                <Input
                  id="activity-from"
                  type="datetime-local"
                  value={draft.from ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, from: e.target.value || undefined })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="activity-to">{t("to")}</Label>
                <Input
                  id="activity-to"
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
            ) : allRows.length === 0 ? (
              <EmptyState
                icon={RiHistoryLine}
                title={t("noActivity")}
                description={
                  hasFilters
                    ? t("noActivityFilteredDescription")
                    : t("noActivityDescription")
                }
              />
            ) : (
              <>
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("colTime")}</TableHead>
                        <TableHead>{t("colActor")}</TableHead>
                        <TableHead>{t("colEvent")}</TableHead>
                        <TableHead>{t("colSource")}</TableHead>
                        <TableHead className="w-24" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {allRows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="text-sm whitespace-nowrap">
                            {formatDateTime(locale, row.at)}
                          </TableCell>
                          <TableCell className="max-w-48 truncate text-sm">
                            {row.actorLabel}
                          </TableCell>
                          <TableCell className="text-sm">
                            {row.title}
                            <p className="max-w-48 truncate font-mono text-xs text-muted-foreground">
                              {row.kind}
                            </p>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{row.source}</Badge>
                          </TableCell>
                          <TableCell>
                            {row.source === "audit" ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  setSelectedAuditId(
                                    row.id.slice("audit:".length)
                                  )
                                }
                              >
                                {t("view")}
                              </Button>
                            ) : (
                              <Button asChild variant="ghost" size="sm">
                                <Link href={row.detailHref}>{t("view")}</Link>
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="mt-4 flex items-center justify-between gap-2">
                  <p className="text-sm text-muted-foreground">
                    {t("showingCount", { count: allRows.length })}
                  </p>
                  {cursor !== null && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={loadMore}
                      disabled={loadingMore}
                    >
                      {loadingMore ? t("loadingMore") : t("loadMore")}
                    </Button>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <Dialog
        open={selectedAuditId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedAuditId(null)
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("detailTitle")}</DialogTitle>
          </DialogHeader>
          {selectedAuditId !== null && <AuditLogDetail id={selectedAuditId} />}
        </DialogContent>
      </Dialog>
    </Tabs>
  )
}

/** One audit event, loaded only while the detail dialog is open —
    the same detail the audit-log explorer shows for the row. */
function AuditLogDetail({ id }: { id: string }) {
  const { t } = useTranslation("activity")
  const locale = useLocale()
  const { data, isLoading } = useAuditLog(id)

  if (isLoading) return <Skeleton className="h-48 w-full" />
  if (!data) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {t("noActivity")}
      </p>
    )
  }

  const log = data
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <p>
          <span className="font-medium">{t("colTime")}: </span>
          {formatDateTime(locale, log.createdAt)}
        </p>
        <p>
          <span className="font-medium">{t("colActor")}: </span>
          {log.actor?.name ?? log.actor?.email ?? t("actorSystem")}
        </p>
        <p>
          <span className="font-medium">{t("colEvent")}: </span>
          {log.action}
        </p>
        <p>
          <span className="font-medium">{t("colSource")}: </span>
          {log.resourceType} ·{" "}
          <span className="font-mono text-xs">{log.resourceId}</span>
        </p>
        <p>
          <span className="font-medium">{t("outcome")}: </span>
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
