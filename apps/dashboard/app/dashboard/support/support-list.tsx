"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMyTickets } from "@sendcms/support/queries"
import type { MyTicketsPage } from "@sendcms/support"
import type { TicketStatus } from "@sendcms/database"
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
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
import { RiCustomerServiceLine } from "@remixicon/react"
import {
  useLocale,
  useTranslation,
} from "@/components/dashboard/translation-provider"
import { ListSearchInput } from "@/components/dashboard/list-search-input"
import { formatDate } from "@sendcms/i18n"

const STATUS_KEYS: Record<TicketStatus, string> = {
  OPEN: "statusOpen",
  IN_PROGRESS: "statusInProgress",
  WAITING_ON_CUSTOMER: "statusWaitingOnCustomer",
  RESOLVED: "statusResolved",
  CLOSED: "statusClosed",
}

const STATUS_VARIANTS: Record<
  TicketStatus,
  "default" | "secondary" | "outline"
> = {
  OPEN: "default",
  IN_PROGRESS: "secondary",
  WAITING_ON_CUSTOMER: "outline",
  RESOLVED: "secondary",
  CLOSED: "outline",
}

const PRIORITY_KEYS = {
  LOW: "priorityLow",
  NORMAL: "priorityNormal",
  HIGH: "priorityHigh",
  URGENT: "priorityUrgent",
} as const

type Filters = {
  status?: TicketStatus
  search?: string
  page: number
  perPage: number
}

type Props = {
  initialData: MyTicketsPage
  filters: Filters
}

/**
 * The customer's ticket list: a status filter and pagination driven
 * by the URL, a table of their own tickets, and a link to the
 * new-ticket page. Every number comes from the service.
 */
export function SupportList({ initialData, filters }: Props) {
  const { t } = useTranslation("support")
  const locale = useLocale()
  const router = useRouter()
  const { data } = useMyTickets(filters, initialData)
  const page = data ?? initialData

  function pushFilters(next: Partial<Filters>) {
    const params = new URLSearchParams()
    const status = next.status ?? filters.status
    if (status) params.set("status", status)
    // DSH-410: keep the subject search and page size in the URL
    // across status/page changes (the old version rebuilt the params
    // from status + page only, silently dropping both).
    const search = next.search ?? filters.search
    if (search) params.set("search", search)
    const perPage = next.perPage ?? filters.perPage
    if (perPage !== 20) params.set("perPage", String(perPage))
    const pageValue = next.page ?? 1
    if (pageValue > 1) params.set("page", String(pageValue))
    const query = params.toString()
    router.push(`/dashboard/support${query ? `?${query}` : ""}`)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <ListSearchInput domain="support" defaultValue={filters.search ?? ""} />
        <Select
          value={filters.status ?? "all"}
          onValueChange={(value) =>
            pushFilters({
              status: value === "all" ? undefined : (value as TicketStatus),
            })
          }
        >
          <SelectTrigger className="h-9 w-44" aria-label={t("colStatus")}>
            <SelectValue placeholder={t("colStatus")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("colStatus")}</SelectItem>
            {(
              [
                "OPEN",
                "IN_PROGRESS",
                "WAITING_ON_CUSTOMER",
                "RESOLVED",
                "CLOSED",
              ] as TicketStatus[]
            ).map((status) => (
              <SelectItem key={status} value={status}>
                {t(STATUS_KEYS[status])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* DSH-410: page size (10/20/50) — the API already supports
            ?perPage= up to 100; the customer list never exposed it. */}
        <Select
          value={String(filters.perPage)}
          onValueChange={(value) =>
            pushFilters({ perPage: Number(value), page: 1 })
          }
        >
          <SelectTrigger className="h-9 w-36" aria-label={t("perPageLabel")}>
            <SelectValue placeholder={t("perPageLabel")} />
          </SelectTrigger>
          <SelectContent>
            {[10, 20, 50].map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size} / {t("perPageLabel")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {page.tickets.length === 0 ? (
        // UX-104/110: the shared empty state, with NO cta — "New
        // ticket" already sits in the PageHeader action slot.
        <EmptyState
          icon={RiCustomerServiceLine}
          title={t("emptyTickets")}
          description={t("emptyTicketsDescription")}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colSubject")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead>{t("colPriority")}</TableHead>
                  <TableHead>{t("colMessages")}</TableHead>
                  <TableHead>{t("colUpdated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.tickets.map((ticket) => (
                  <TableRow key={ticket.id}>
                    <TableCell>
                      <Link
                        href={`/dashboard/support/${ticket.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {ticket.subject}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANTS[ticket.status]}>
                        {t(STATUS_KEYS[ticket.status])}
                      </Badge>
                    </TableCell>
                    <TableCell>{t(PRIORITY_KEYS[ticket.priority])}</TableCell>
                    <TableCell>{ticket.messageCount}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(locale, ticket.updatedAt, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {page.totalPages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {t("pageOf", {
              page: page.page,
              totalPages: page.totalPages,
            })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={page.page <= 1}
              onClick={() => pushFilters({ page: page.page - 1 })}
            >
              {t("prevPage")}
            </Button>
            <Button
              variant="outline"
              disabled={page.page >= page.totalPages}
              onClick={() => pushFilters({ page: page.page + 1 })}
            >
              {t("nextPage")}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
