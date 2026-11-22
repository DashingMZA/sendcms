"use client"

import Link from "next/link"
import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { adminCan, type AdminRole } from "@sendcms/permissions"
import { useAdminTickets, useStaffUsers } from "@sendcms/support/queries"
import type { AdminTicketsPage } from "@sendcms/support"
import type { TicketPriority, TicketStatus } from "@sendcms/database"
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
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
import { useTranslation } from "@/components/admin/translation-provider"

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
  priority?: TicketPriority
  assignedToId?: string
  search?: string
  page: number
  perPage: number
}

type Props = {
  initialData: AdminTicketsPage
  filters: Filters
  actorRole: AdminRole | "PLATFORM_OWNER" | "PLATFORM_USER"
}

function formatDate(value: Date | string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

/**
 * The admin support queue: status/priority/assignee filters, a
 * debounced subject search, and pagination driven by the URL. The
 * assignee filter only renders for actors who may assign
 * (MANAGE_USERS) — the staff list itself needs that capability.
 */
export function SupportQueue({ initialData, filters, actorRole }: Props) {
  const { t } = useTranslation("support")
  const router = useRouter()
  const { data } = useAdminTickets(filters, initialData)
  const page = data ?? initialData

  const canManageUsers = adminCan(actorRole, "MANAGE_USERS")
  const { data: staffUsers } = useStaffUsers({ enabled: canManageUsers })
  const [search, setSearch] = useState(filters.search ?? "")
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function pushFilters(next: Partial<Filters>) {
    const params = new URLSearchParams()
    const status = next.status ?? filters.status
    if (status) params.set("status", status)
    const priority = next.priority ?? filters.priority
    if (priority) params.set("priority", priority)
    const assignedToId = next.assignedToId ?? filters.assignedToId
    if (assignedToId) params.set("assignedToId", assignedToId)
    const searchValue = next.search ?? filters.search
    if (searchValue) params.set("search", searchValue)
    const pageValue = next.page ?? 1
    if (pageValue > 1) params.set("page", String(pageValue))
    const query = params.toString()
    router.push(`/admin/support${query ? `?${query}` : ""}`)
  }

  function handleSearchChange(value: string) {
    setSearch(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      pushFilters({ search: value.trim() || undefined, page: 1 })
    }, 400)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(event) => handleSearchChange(event.target.value)}
          placeholder={t("searchPlaceholder")}
          className="h-9 w-64"
        />
        <Select
          value={filters.status ?? "all"}
          onValueChange={(value) =>
            pushFilters({
              status: value === "all" ? undefined : (value as TicketStatus),
              page: 1,
            })
          }
        >
          <SelectTrigger className="h-9 w-44">
            <SelectValue placeholder={t("filterStatus")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filterAll")}</SelectItem>
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
        <Select
          value={filters.priority ?? "all"}
          onValueChange={(value) =>
            pushFilters({
              priority: value === "all" ? undefined : (value as TicketPriority),
              page: 1,
            })
          }
        >
          <SelectTrigger className="h-9 w-36">
            <SelectValue placeholder={t("filterPriority")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filterAll")}</SelectItem>
            {(["LOW", "NORMAL", "HIGH", "URGENT"] as TicketPriority[]).map(
              (priority) => (
                <SelectItem key={priority} value={priority}>
                  {t(PRIORITY_KEYS[priority])}
                </SelectItem>
              )
            )}
          </SelectContent>
        </Select>
        {canManageUsers && staffUsers && (
          <Select
            value={filters.assignedToId ?? "all"}
            onValueChange={(value) =>
              pushFilters({
                assignedToId: value === "all" ? undefined : value,
                page: 1,
              })
            }
          >
            <SelectTrigger className="h-9 w-48">
              <SelectValue placeholder={t("filterAssignee")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("filterAll")}</SelectItem>
              {staffUsers.map((staff) => (
                <SelectItem key={staff.id} value={staff.id}>
                  {staff.name ?? staff.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {page.tickets.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="mb-1 text-sm font-medium">{t("emptyTickets")}</p>
            <p className="text-sm text-muted-foreground">
              {t("emptyTicketsDescription")}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colSubject")}</TableHead>
                  <TableHead>{t("colUser")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead>{t("colPriority")}</TableHead>
                  <TableHead>{t("colAssignee")}</TableHead>
                  <TableHead>{t("colMessages")}</TableHead>
                  <TableHead>{t("colUpdated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.tickets.map((ticket) => (
                  <TableRow key={ticket.id}>
                    <TableCell>
                      <Link
                        href={`/admin/support/${ticket.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {ticket.subject}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/admin/users/${ticket.userId}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {ticket.user?.name ??
                          ticket.user?.email ??
                          ticket.userId}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANTS[ticket.status]}>
                        {t(STATUS_KEYS[ticket.status])}
                      </Badge>
                    </TableCell>
                    <TableCell>{t(PRIORITY_KEYS[ticket.priority])}</TableCell>
                    <TableCell>
                      {ticket.assignedTo
                        ? (ticket.assignedTo.name ?? ticket.assignedTo.email)
                        : t("unassigned")}
                    </TableCell>
                    <TableCell>{ticket.messageCount}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(ticket.updatedAt)}
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
