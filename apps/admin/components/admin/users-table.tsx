"use client"

import { useCallback, useRef, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  useAdminUsers,
  type AdminUserListQuery,
  type AdminUsersListResponse,
} from "@sendcms/admin-users/queries"
import {
  Button,
  Label,
  SearchInput,
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
import { RiUserLine } from "@remixicon/react"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDate } from "./plan-format"
import { UserRoleBadge, UserStatusBadge } from "./user-status-badge"

const DEBOUNCE_MS = 300

type Props = {
  initialData: AdminUsersListResponse
  filters: AdminUserListQuery
  // DOC-003: accounts awaiting approval (from the server component —
  // the filtered total when ?status=PENDING_APPROVAL is active, else
  // one extra listUsers call). The banner shows only when this is > 0.
  pendingCount: number
}

export function UsersTable({ initialData, filters, pendingCount }: Props) {
  const { t } = useTranslation("users")
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const { data, isFetching, isError, refetch } = useAdminUsers(
    filters,
    initialData
  )
  const list = data ?? initialData

  const pageCount = Math.max(1, Math.ceil(list.total / list.perPage))
  const from = list.total === 0 ? 0 : (list.page - 1) * list.perPage + 1
  const to = Math.min(list.total, list.page * list.perPage)

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
    router.push(pathname)
  }

  const hasFilters = Boolean(
    filters.q ||
    filters.status ||
    filters.adminRole ||
    filters.emailVerified !== undefined
  )

  // DOC-003: the queue link — the pending filter on this same page.
  const pendingParams = new URLSearchParams(searchParams.toString())
  pendingParams.set("status", "PENDING_APPROVAL")
  pendingParams.delete("page")
  const pendingHref = `${pathname}?${pendingParams.toString()}`

  return (
    <div className="flex flex-col gap-4">
      {/* UX-011: section heading for the outline — see plans-table. */}
      <h2 className="sr-only">{t("title")}</h2>
      <div className="flex flex-wrap items-end gap-3">
        <UsersSearchInput defaultValue={filters.q ?? ""} />
        <div className="space-y-1">
          <Label htmlFor="users-status-filter">{t("statusFilterLabel")}</Label>
          <Select
            value={filters.status ?? "all"}
            onValueChange={(value) =>
              setParam("status", value === "all" ? null : value)
            }
          >
            <SelectTrigger id="users-status-filter" className="h-9 w-44">
              <SelectValue placeholder={t("statusAll")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("statusAll")}</SelectItem>
              <SelectItem value="ACTIVE">{t("statusActive")}</SelectItem>
              <SelectItem value="PENDING_APPROVAL">
                {t("statusPendingApproval")}
              </SelectItem>
              <SelectItem value="SUSPENDED">{t("statusSuspended")}</SelectItem>
              <SelectItem value="DISABLED">{t("statusDisabled")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="users-role-filter">{t("roleFilterLabel")}</Label>
          <Select
            value={filters.adminRole ?? "all"}
            onValueChange={(value) =>
              setParam("adminRole", value === "all" ? null : value)
            }
          >
            <SelectTrigger id="users-role-filter" className="h-9 w-44">
              <SelectValue placeholder={t("roleAll")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("roleAll")}</SelectItem>
              <SelectItem value="SUPER_ADMIN">{t("roleSuperAdmin")}</SelectItem>
              <SelectItem value="MANAGER">{t("roleManager")}</SelectItem>
              <SelectItem value="SUPPORT">{t("roleSupport")}</SelectItem>
              <SelectItem value="NONE">{t("roleNone")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="users-verified-filter">
            {t("verifiedFilterLabel")}
          </Label>
          <Select
            value={
              filters.emailVerified === undefined
                ? "all"
                : filters.emailVerified
                  ? "true"
                  : "false"
            }
            onValueChange={(value) =>
              setParam("emailVerified", value === "all" ? null : value)
            }
          >
            <SelectTrigger id="users-verified-filter" className="h-9 w-44">
              <SelectValue placeholder={t("verifiedAll")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("verifiedAll")}</SelectItem>
              <SelectItem value="true">{t("verifiedYes")}</SelectItem>
              <SelectItem value="false">{t("verifiedNo")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            {t("clearFilters")}
          </Button>
        )}
        {/* ADM-005: the sort + per-page the API already supports,
            URL-as-state like the existing filters. */}
        <div className="space-y-1">
          <Label htmlFor="users-sort">{t("sortLabel")}</Label>
          <Select
            value={filters.sort ?? "createdAt:desc"}
            onValueChange={(value) => setParam("sort", value)}
          >
            <SelectTrigger id="users-sort" className="h-9 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="createdAt:desc">
                {t("sortCreatedDesc")}
              </SelectItem>
              <SelectItem value="createdAt:asc">
                {t("sortCreatedAsc")}
              </SelectItem>
              <SelectItem value="name:asc">{t("sortNameAsc")}</SelectItem>
              <SelectItem value="name:desc">{t("sortNameDesc")}</SelectItem>
              <SelectItem value="email:asc">{t("sortEmailAsc")}</SelectItem>
              <SelectItem value="email:desc">{t("sortEmailDesc")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="users-per-page">{t("perPageLabel")}</Label>
          <Select
            value={String(filters.perPage ?? 20)}
            onValueChange={(value) => setParam("perPage", value)}
          >
            <SelectTrigger id="users-per-page" className="h-9 w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[10, 20, 50, 100].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* ADM-006: a refetch shows a loading indicator instead of
            silently keeping the old rows on screen. */}
        {isFetching && (
          <span
            aria-live="polite"
            className="self-center text-sm text-muted-foreground"
          >
            {t("refreshing")}
          </span>
        )}
      </div>

      {/* ADM-006: a failed refetch shows an inline error instead of
          silently stale data (the table below still shows the last
          good rows, labelled stale by this banner). */}
      {isError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm"
        >
          <span>{t("loadError")}</span>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            {t("retry")}
          </Button>
        </div>
      )}

      {/* DOC-003: pending-approval queue banner — shown only when
          accounts are awaiting approval; the link filters the list
          to the queue (?status=PENDING_APPROVAL). */}
      {pendingCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted px-4 py-3 text-sm">
          <span>{t("pendingCount", { count: pendingCount })}</span>
          <Link
            href={pendingHref}
            className="font-medium text-foreground underline underline-offset-4"
          >
            {t("view")}
          </Link>
        </div>
      )}

      {list.total === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-20 text-center">
          <RiUserLine
            className="mb-4 size-10 text-muted-foreground"
            aria-hidden="true"
          />
          <h3 className="mb-1 text-lg font-semibold text-balance">
            {t("noUsersTitle")}
          </h3>
          <p className="max-w-sm text-sm text-muted-foreground">
            {hasFilters
              ? t("noUsersDescription")
              : t("noUsersEmptyDescription")}
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colUser")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead>{t("colRole")}</TableHead>
                  <TableHead>{t("colVerified")}</TableHead>
                  <TableHead>{t("colForms")}</TableHead>
                  <TableHead>{t("colDomains")}</TableHead>
                  <TableHead>{t("colSubmissions")}</TableHead>
                  <TableHead>{t("colCreated")}</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <p className="font-medium">{user.name}</p>
                      <p className="text-sm text-muted-foreground">
                        <bdi dir="ltr">{user.email}</bdi>
                      </p>
                    </TableCell>
                    <TableCell>
                      <UserStatusBadge
                        status={user.status}
                        labels={{
                          active: t("statusActive"),
                          pending: t("statusPendingApproval"),
                          suspended: t("statusSuspended"),
                          disabled: t("statusDisabled"),
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <UserRoleBadge
                        role={user.adminRole}
                        labels={{
                          superAdmin: t("roleSuperAdmin"),
                          manager: t("roleManager"),
                          support: t("roleSupport"),
                          none: t("roleNone"),
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      {user.emailVerified ? t("verifiedYes") : t("verifiedNo")}
                    </TableCell>
                    <TableCell>{user.counts.forms}</TableCell>
                    <TableCell>{user.counts.domains}</TableCell>
                    <TableCell>{user.counts.submissions}</TableCell>
                    <TableCell>{formatDate(locale, user.createdAt)}</TableCell>
                    <TableCell>
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/admin/all-users/${user.id}`}>
                          {t("view")}
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{t("showing", { from, to, total: list.total })}</span>
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
        </>
      )}
    </div>
  )
}

/** Debounced search over name/email (URL param `q`), same shape as the
    dashboard's inbox search input. Resets to page 1 on change. */
function UsersSearchInput({ defaultValue = "" }: { defaultValue?: string }) {
  const { t } = useTranslation("users")
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [value, setValue] = useState(defaultValue)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const updateSearch = useCallback(
    (search: string) => {
      const params = new URLSearchParams(searchParams.toString())
      if (search.trim()) {
        params.set("q", search.trim())
      } else {
        params.delete("q")
      }
      params.delete("page")
      router.push(`${pathname}?${params.toString()}`)
    },
    [pathname, router, searchParams]
  )

  function handleChange(next: string) {
    setValue(next)
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    debounceRef.current = setTimeout(() => {
      updateSearch(next)
    }, DEBOUNCE_MS)
  }

  function handleClear() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    setValue("")
    updateSearch("")
  }

  return (
    <SearchInput
      id="users-search"
      label={t("searchPlaceholder")}
      placeholder={t("searchPlaceholder")}
      value={value}
      onChange={handleChange}
      onClear={handleClear}
      clearLabel={t("clearFilters")}
    />
  )
}
