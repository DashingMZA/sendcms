"use client"

import { useCallback, useRef, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Search, X } from "lucide-react"
import {
  useAdminUsers,
  type AdminUserListQuery,
  type AdminUsersListResponse,
} from "@sendcms/admin-users/queries"
import {
  Button,
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
import { RiUserLine } from "@remixicon/react"
import { useTranslation } from "@/components/admin/translation-provider"
import { UserRoleBadge, UserStatusBadge } from "./user-status-badge"

const DEBOUNCE_MS = 300

function formatDate(value: string | Date | null) {
  if (!value) return "—"
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

type Props = {
  initialData: AdminUsersListResponse
  filters: AdminUserListQuery
}

export function UsersTable({ initialData, filters }: Props) {
  const { t } = useTranslation("users")
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const { data } = useAdminUsers(filters, initialData)
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

  return (
    <div className="flex flex-col gap-4">
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
      </div>

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
                        {user.email}
                      </p>
                    </TableCell>
                    <TableCell>
                      <UserStatusBadge
                        status={user.status}
                        labels={{
                          active: t("statusActive"),
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
                    <TableCell>{formatDate(user.createdAt)}</TableCell>
                    <TableCell>
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/admin/users/${user.id}`}>
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

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value
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
    <div className="relative">
      <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="text"
        placeholder={t("searchPlaceholder")}
        value={value}
        onChange={handleChange}
        className="h-9 w-64 pr-9 pl-9 text-sm"
      />
      {value && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
          aria-label={t("clearFilters")}
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}
