"use client"

import { useState } from "react"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import type { BillingProvider } from "@sendcms/database"
import { BILLING_PROVIDERS } from "@sendcms/billing/registry"
import {
  useBillingEvents,
  type BillingEventsFilters,
} from "@sendcms/billing/queries"
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
import { formatDateTime } from "./plan-format"

type Props = {
  actorRole: PlatformRole | AdminRole
}

type Filters = Omit<BillingEventsFilters, "page" | "perPage">

// Billing events (ADM-123 / BIL-123 / BIL-092): the webhook receipts +
// payment events the providers actually delivered, newest first.
// Unprocessed rows (processedAt null) are the failed deliveries —
// events the handler received but never applied. Duplicate deliveries
// never create a second row (unique (provider, providerEventId)), so
// the single row and its processed state are the record of the
// delivery. Filters follow the audit explorer's draft/applied split:
// typing does not refetch on every keystroke.
export function BillingEventsTable({ actorRole }: Props) {
  const { t } = useTranslation("billing")
  const locale = useLocale()
  const canViewBilling = adminCan(actorRole, "VIEW_BILLING")

  const [draft, setDraft] = useState<Filters>({})
  const [applied, setApplied] = useState<Filters>({})
  const [page, setPage] = useState(1)

  const { data, isLoading, isError } = useBillingEvents({
    ...applied,
    page,
    perPage: 20,
  })
  const events = data?.events ?? []
  const totalPages = data?.totalPages ?? 1
  const currentPage = data?.page ?? page

  if (!canViewBilling) return null

  function applyFilters() {
    setApplied(draft)
    setPage(1)
  }

  function clearFilters() {
    setDraft({})
    setApplied({})
    setPage(1)
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("eventsTitle")}</CardTitle>
          <CardDescription>{t("eventsDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="billing-events-provider">
                {t("filterProvider")}
              </Label>
              <Select
                value={draft.provider ?? "all"}
                onValueChange={(v) =>
                  setDraft({
                    ...draft,
                    provider: v === "all" ? undefined : (v as BillingProvider),
                  })
                }
              >
                <SelectTrigger id="billing-events-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("all")}</SelectItem>
                  {BILLING_PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="billing-events-type">
                {t("filterEventType")}
              </Label>
              <Input
                id="billing-events-type"
                value={draft.eventType ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    eventType: e.target.value || undefined,
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="billing-events-processed">
                {t("filterProcessed")}
              </Label>
              <Select
                value={
                  draft.processed === undefined
                    ? "all"
                    : draft.processed
                      ? "processed"
                      : "unprocessed"
                }
                onValueChange={(v) =>
                  setDraft({
                    ...draft,
                    processed: v === "all" ? undefined : v === "processed",
                  })
                }
              >
                <SelectTrigger id="billing-events-processed">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("processedAll")}</SelectItem>
                  <SelectItem value="processed">
                    {t("processedOnly")}
                  </SelectItem>
                  <SelectItem value="unprocessed">
                    {t("unprocessedOnly")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="billing-events-from">{t("from")}</Label>
              <Input
                id="billing-events-from"
                type="datetime-local"
                value={draft.from ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, from: e.target.value || undefined })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="billing-events-to">{t("to")}</Label>
              <Input
                id="billing-events-to"
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
        <CardContent className="pt-6">
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : isError ? (
            <p className="py-10 text-center text-sm text-destructive">
              {t("eventsError")}
            </p>
          ) : events.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("eventsNoEvents")}
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colProvider")}</TableHead>
                    <TableHead>{t("colEventType")}</TableHead>
                    <TableHead>{t("colEventId")}</TableHead>
                    <TableHead>{t("colProcessed")}</TableHead>
                    <TableHead>{t("colReceived")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="text-sm">
                        {BILLING_PROVIDERS.find((p) => p.id === event.provider)
                          ?.label ?? event.provider}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{event.eventType}</Badge>
                      </TableCell>
                      <TableCell className="max-w-48 truncate font-mono text-xs text-muted-foreground">
                        {event.providerEventId}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            event.processed ? "secondary" : "destructive"
                          }
                        >
                          {event.processed
                            ? t("processedYes")
                            : t("processedNo")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatDateTime(locale, event.createdAt)}
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
    </div>
  )
}
