"use client"

import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useDomainsPage } from "@sendcms/domains/queries"
import type {
  DomainListQueryInput,
  DomainListResult,
} from "@sendcms/domains/queries"

import { DomainStatusBadge } from "./domain-status-badge"
import { ListSearchInput } from "@/components/dashboard/list-search-input"
import {
  Button,
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

import { RiAddLine, RiGlobalLine } from "@remixicon/react"
import { formatDate } from "@sendcms/i18n"
import {
  useLocale,
  useTranslation,
} from "@/components/dashboard/translation-provider"

type SortOption = "newest" | "oldest" | "nameAsc" | "nameDesc"

function sortValue(params: DomainListQueryInput): SortOption {
  if (params.sortBy === "name") {
    return params.sortDir === "asc" ? "nameAsc" : "nameDesc"
  }
  return params.sortDir === "asc" ? "oldest" : "newest"
}

export function DomainsTable({
  initialData,
  params,
}: {
  initialData: DomainListResult
  params: DomainListQueryInput
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { t } = useTranslation("domains")
  const locale = useLocale()
  const { data } = useDomainsPage(params, initialData)
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

  function onSortChange(value: string) {
    const next = new URLSearchParams(searchParams.toString())
    switch (value as SortOption) {
      case "oldest":
        next.set("sortBy", "createdAt")
        next.set("sortDir", "asc")
        break
      case "nameAsc":
        next.set("sortBy", "name")
        next.set("sortDir", "asc")
        break
      case "nameDesc":
        next.set("sortBy", "name")
        next.set("sortDir", "desc")
        break
      default:
        next.set("sortBy", "createdAt")
        next.set("sortDir", "desc")
    }
    next.delete("page")
    pushParams(next)
  }

  // "DNS TXT" is the technical method name and stays as-is.
  const METHOD_LABEL: Record<string, string> = {
    DNS_TXT: "DNS TXT",
    META_TAG: t("methodMetaTagShort"),
    FILE: t("methodFileShort"),
  }

  if (list.total === 0 && !params.search) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-20 text-center">
        <RiGlobalLine
          className="mb-4 size-10 text-muted-foreground"
          aria-hidden="true"
        />
        <h3 className="mb-1 text-lg font-semibold text-balance">
          {t("emptyTitle")}
        </h3>
        <p className="mb-4 max-w-sm text-sm text-muted-foreground">
          {t("emptyDescription")}
        </p>
        <Button asChild size="sm">
          <Link href="/dashboard/domains/new">
            <RiAddLine className="size-4" aria-hidden="true" />
            {t("addDomain")}
          </Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <ListSearchInput domain="domains" defaultValue={params.search ?? ""} />
        <div className="space-y-1">
          <Label htmlFor="domains-sort">{t("sortLabel")}</Label>
          <Select value={sortValue(params)} onValueChange={onSortChange}>
            <SelectTrigger id="domains-sort" className="h-9 w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">{t("sortNewest")}</SelectItem>
              <SelectItem value="oldest">{t("sortOldest")}</SelectItem>
              <SelectItem value="nameAsc">{t("sortNameAsc")}</SelectItem>
              <SelectItem value="nameDesc">{t("sortNameDesc")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colDomain")}</TableHead>
              <TableHead>{t("colStatus")}</TableHead>
              <TableHead>{t("colMethod")}</TableHead>
              <TableHead>{t("colVerified")}</TableHead>
              <TableHead>{t("colForms")}</TableHead>
              <TableHead>{t("colAdded")}</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-12 text-center">
                  <p className="mb-2 font-medium">{t("noResults")}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setParam("search", null)}
                  >
                    {t("clearSearch")}
                  </Button>
                </TableCell>
              </TableRow>
            )}
            {list.items.map((domain) => {
              const verification = domain.verifications[0]
              return (
                <TableRow key={domain.id}>
                  <TableCell className="font-medium">{domain.domain}</TableCell>
                  <TableCell>
                    <DomainStatusBadge status={domain.status} />
                  </TableCell>
                  <TableCell>
                    {verification ? METHOD_LABEL[verification.method] : "—"}
                  </TableCell>
                  <TableCell>
                    {domain.verifiedAt
                      ? formatDate(locale, domain.verifiedAt, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })
                      : "—"}
                  </TableCell>
                  <TableCell>{domain._count.formLinks}</TableCell>
                  <TableCell>
                    {domain.createdAt
                      ? formatDate(locale, domain.createdAt, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/dashboard/domains/${domain.id}`}>
                        {t("view")}
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
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
    </div>
  )
}
