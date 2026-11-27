"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import { useAiUsage, useAiUsageSummary } from "@sendcms/ai-settings/queries"
import type { AiBillingMode } from "@sendcms/database"
import type { AiProviderName } from "@sendcms/ai"
import type { AiUsageListQuery } from "@sendcms/ai-settings/validators"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatCostMicros, providerDisplayName } from "./ai-format"
import { formatDateTime } from "./plan-format"

const ALL_PROVIDERS: AiProviderName[] = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "openrouter",
]
const ALL_MODES: AiBillingMode[] = ["BYOK", "PLATFORM", "DISABLED"]
const ALL_STATUSES = ["SUCCESS", "FAILED", "RETRY"] as const

type Props = {
  actorRole: PlatformRole | AdminRole
  initialFilters: AiUsageListQuery
}

/**
 * The AI usage page (Phase 5): every AI call, with BYOK and platform
 * usage kept separate — the summary cards split them, and the table
 * shows the billing mode of each row. Cost is shown only when the
 * provider reported it (never an estimate).
 */
export function AiUsageTable({ actorRole, initialFilters }: Props) {
  const { t } = useTranslation("ai")
  const locale = useLocale()
  const canViewUsage = adminCan(actorRole, "VIEW_AI_USAGE")
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [provider, setProvider] = useState<string>(
    initialFilters.provider ?? "all"
  )
  const [billingMode, setBillingMode] = useState<string>(
    initialFilters.billingMode ?? "all"
  )
  const [status, setStatus] = useState<string>(initialFilters.status ?? "all")
  const [from, setFrom] = useState(initialFilters.from ?? "")
  const [to, setTo] = useState(initialFilters.to ?? "")
  const [page, setPage] = useState(initialFilters.page)

  const filters = {
    userId: initialFilters.userId,
    provider: provider === "all" ? undefined : (provider as AiProviderName),
    billingMode:
      billingMode === "all" ? undefined : (billingMode as AiBillingMode),
    status:
      status === "all" ? undefined : (status as (typeof ALL_STATUSES)[number]),
    from: from || undefined,
    to: to || undefined,
  }
  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
    refetch: refetchSummary,
  } = useAiUsageSummary(filters)
  const {
    data,
    isLoading,
    isError: listError,
    refetch: refetchList,
  } = useAiUsage({ ...filters, page, perPage: 20 })

  if (!canViewUsage) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("noPermission")}</p>
        </CardContent>
      </Card>
    )
  }

  const rows = data?.usage ?? []
  const totalPages = data?.totalPages ?? 1
  const currentPage = data?.page ?? page
  const byokCost = summary
    ? formatCostMicros(locale, summary.byok.costMicros)
    : null
  const platformCost = summary
    ? formatCostMicros(locale, summary.platform.costMicros)
    : null
  const totalCost = summary
    ? formatCostMicros(locale, summary.total.costMicros)
    : null

  function resetPage() {
    setPage(1)
  }

  // ADM-066: filters + pagination live in the URL (shareable,
  // back-button safe), following the users table. Changing a filter
  // resets to page 1; "all"/empty removes the param.
  function pushParams(next: URLSearchParams) {
    const text = next.toString()
    router.push(text ? `${pathname}?${text}` : pathname)
  }

  function applyFilter(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams.toString())
    if (value === null || value === "" || value === "all") {
      next.delete(key)
    } else {
      next.set(key, value)
    }
    next.delete("page")
    pushParams(next)
  }

  function applyPage(nextPage: number) {
    const next = new URLSearchParams(searchParams.toString())
    next.set("page", String(nextPage))
    pushParams(next)
  }

  return (
    <div className="flex flex-col gap-6">
      {/* AIM-012: a failed summary/list fetch shows an error state
          with a retry instead of literal zeros / a false empty table. */}
      {(summaryError || listError) && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-2 py-6">
            <p role="alert" className="text-sm text-destructive">
              {t("loadError")}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refetchSummary()
                void refetchList()
              }}
            >
              {t("retry")}
            </Button>
          </CardContent>
        </Card>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("byokCalls")}</CardTitle>
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <p className="text-3xl font-bold tracking-tight">
                {summary?.byok.calls ?? 0}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {t("costReported")}: {byokCost ?? "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("platformCalls")}</CardTitle>
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <p className="text-3xl font-bold tracking-tight">
                {summary?.platform.calls ?? 0}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {t("costReported")}: {platformCost ?? "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("totalCalls")}</CardTitle>
            <CardDescription>{t("costNote")}</CardDescription>
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <p className="text-3xl font-bold tracking-tight">
                {summary?.total.calls ?? 0}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {t("costReported")}: {totalCost ?? "—"}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("successCalls")}: {summary?.total.success ?? 0} ·{" "}
              {t("failedCalls")}: {summary?.total.failed ?? 0} ·{" "}
              {t("retryCalls")}: {summary?.total.retry ?? 0}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("usageTitle")}</CardTitle>
          <CardDescription>{t("usageDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="ai-usage-provider">{t("filterProvider")}</Label>
              <Select
                value={provider}
                onValueChange={(v) => {
                  setProvider(v)
                  resetPage()
                  applyFilter("provider", v)
                }}
              >
                <SelectTrigger id="ai-usage-provider" className="h-9 w-44">
                  <SelectValue placeholder={t("allProviders")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("allProviders")}</SelectItem>
                  {ALL_PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {providerDisplayName(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ai-usage-mode">{t("filterBillingMode")}</Label>
              <Select
                value={billingMode}
                onValueChange={(v) => {
                  setBillingMode(v)
                  resetPage()
                  applyFilter("billingMode", v)
                }}
              >
                <SelectTrigger id="ai-usage-mode" className="h-9 w-44">
                  <SelectValue placeholder={t("allModes")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("allModes")}</SelectItem>
                  {ALL_MODES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ai-usage-status">{t("filterStatus")}</Label>
              <Select
                value={status}
                onValueChange={(v) => {
                  setStatus(v)
                  resetPage()
                  applyFilter("status", v)
                }}
              >
                <SelectTrigger id="ai-usage-status" className="h-9 w-44">
                  <SelectValue placeholder={t("allStatuses")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("allStatuses")}</SelectItem>
                  {ALL_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ai-usage-from">{t("filterFrom")}</Label>
              <Input
                id="ai-usage-from"
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value)
                  resetPage()
                  applyFilter("from", e.target.value)
                }}
                className="h-9 w-44"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ai-usage-to">{t("filterTo")}</Label>
              <Input
                id="ai-usage-to"
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value)
                  resetPage()
                  applyFilter("to", e.target.value)
                }}
                className="h-9 w-44"
              />
            </div>
          </div>

          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : listError ? (
            <p
              role="alert"
              className="py-10 text-center text-sm text-destructive"
            >
              {t("loadError")}
            </p>
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("emptyUsage")}
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colUser")}</TableHead>
                    <TableHead>{t("colProvider")}</TableHead>
                    <TableHead>{t("colModel")}</TableHead>
                    <TableHead>{t("colBillingMode")}</TableHead>
                    <TableHead>{t("colTokens")}</TableHead>
                    <TableHead>{t("colCost")}</TableHead>
                    <TableHead>{t("colStatus")}</TableHead>
                    <TableHead>{t("colSource")}</TableHead>
                    <TableHead>{t("colTime")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">
                        {row.user ? (
                          <Link
                            href={`/admin/all-users/${row.userId}`}
                            className="hover:underline"
                          >
                            {row.user.name ?? row.user.email}
                          </Link>
                        ) : (
                          row.userId
                        )}
                      </TableCell>
                      <TableCell>{providerDisplayName(row.provider)}</TableCell>
                      <TableCell>{row.model}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{row.billingMode}</Badge>
                      </TableCell>
                      <TableCell>
                        {row.tokensIn ?? "—"} / {row.tokensOut ?? "—"}
                      </TableCell>
                      <TableCell>
                        {row.costMicros === null
                          ? "—"
                          : (formatCostMicros(locale, row.costMicros) ?? "—")}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{row.status}</Badge>
                      </TableCell>
                      <TableCell>{row.sourceEvent ?? "—"}</TableCell>
                      <TableCell>
                        {formatDateTime(locale, row.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t("pageOf", { page: currentPage, totalPages })}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={currentPage <= 1}
                onClick={() => {
                  setPage(currentPage - 1)
                  applyPage(currentPage - 1)
                }}
              >
                {t("prevPage")}
              </Button>
              <Button
                variant="outline"
                disabled={currentPage >= totalPages}
                onClick={() => {
                  setPage(currentPage + 1)
                  applyPage(currentPage + 1)
                }}
              >
                {t("nextPage")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
