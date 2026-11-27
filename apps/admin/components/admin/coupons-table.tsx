// Coupons table (Phase D, plan §3.7 — thin table on the
// payments-table shape).
//
// Server-fed per tab: the page fetches the list, this component
// renders it — with the same columns, search, and URL pagination as
// the other admin tables. The detail dialog lives in
// coupons-detail-dialog.tsx (it is only rendered with a real id, so
// its useCoupon / useCouponRedemptions hooks never see a null id).
// Disable is a PATCH { status: "DISABLED" } via useDisableCoupon;
// delete is the soft-delete via useDeleteCoupon. Single action →
// ghost link; two or more actions → DropdownMenu (Wave 10, UX-111).
// The services enforce the MANAGE_BILLING gate server-side
// regardless — canManage only hides the buttons.
//
// No enable action and no field edits in v1: Stream A ships no
// updateCoupon / UpdateCouponSchema, so a DISABLED coupon cannot be
// re-enabled from this page yet (consolidation gap — see the PATCH
// route comment).
"use client"

import { useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Label,
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
import { RiCouponLine, RiMoreLine } from "@remixicon/react"
import { useDeleteCoupon, useDisableCoupon } from "@sendcms/coupons/queries"
import type { CouponsQuery } from "@sendcms/coupons/validators"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatAmountMinor, formatDate } from "./plan-format"
import { CouponsDetailDialog } from "./coupons-detail-dialog"

export type CouponTab = "active" | "disabled" | "expired"

export type CouponRow = {
  id: string
  code: string
  name: string | null
  description: string | null
  discountType: "PERCENT" | "FIXED"
  discountValue: number
  currency: string
  maxRedemptions: number | null
  maxRedemptionsPerUser: number | null
  redemptionCount: number
  validFrom: string | null
  validUntil: string | null
  appliesToPlanIds: string[]
  appliesToBillingInterval: string | null
  firstPurchaseOnly: boolean
  status: "ACTIVE" | "DISABLED" | "EXPIRED"
  createdById: string | null
  createdAt: string
  updatedAt: string
}

export type CouponsPage = {
  coupons: CouponRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export type CouponFilters = CouponsQuery

type Props = {
  initialData: CouponsPage
  filters: CouponFilters
  tab: CouponTab
  canManage: boolean
}

const TABS: CouponTab[] = ["active", "disabled", "expired"]

const STATUS_LABEL_KEYS: Record<CouponRow["status"], string> = {
  ACTIVE: "statusActive",
  DISABLED: "statusDisabled",
  EXPIRED: "statusExpired",
}

/** Discount label for a row or a CouponSummary (same three fields). */
export function couponDiscountLabel(
  row: Pick<CouponRow, "discountType" | "discountValue" | "currency">,
  locale: string,
  t: (key: string, vars?: Record<string, string | number>) => string
): string {
  if (row.discountType === "PERCENT") {
    return t("discountPercent", { value: row.discountValue })
  }
  return t("discountFixed", {
    amount: formatAmountMinor(
      locale,
      row.discountValue,
      row.currency,
      t("amountUnknown")
    ),
  })
}

export function CouponsTable({ initialData, filters, tab, canManage }: Props) {
  const { t } = useTranslation("coupons")
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const list = initialData

  const [detailId, setDetailId] = useState<string | null>(null)
  const [disableRow, setDisableRow] = useState<CouponRow | null>(null)
  const [deleteRow, setDeleteRow] = useState<CouponRow | null>(null)

  const disableCoupon = useDisableCoupon(disableRow?.id ?? "")
  const deleteCoupon = useDeleteCoupon()

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

  function setTab(nextTab: string) {
    if ((TABS as string[]).includes(nextTab)) {
      setParam("tab", nextTab)
    }
  }

  function setPage(page: number) {
    const next = new URLSearchParams(searchParams.toString())
    next.set("page", String(page))
    pushParams(next)
  }

  function clearFilters() {
    const next = new URLSearchParams(searchParams.toString())
    next.delete("search")
    next.delete("page")
    pushParams(next)
  }

  function handleSearchSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    setParam("search", (data.get("search") as string | null) ?? null)
  }

  const hasFilters = Boolean(filters.search)

  async function confirmDisable() {
    if (!disableRow) return
    try {
      await disableCoupon.mutateAsync()
      toast.success(t("disableToast"))
      setDisableRow(null)
      router.refresh()
    } catch {
      // The global mutation error toast reports the failure; the
      // dialog stays open so the admin can retry.
    }
  }

  async function confirmDelete() {
    if (!deleteRow) return
    try {
      await deleteCoupon.mutateAsync(deleteRow.id)
      toast.success(t("deleteToast"))
      setDeleteRow(null)
      if (detailId === deleteRow.id) setDetailId(null)
      router.refresh()
    } catch {
      // The global mutation error toast reports the failure; the
      // dialog stays open so the admin can retry.
    }
  }

  return (
    <>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="active">{t("tabActive")}</TabsTrigger>
          <TabsTrigger value="disabled">{t("tabDisabled")}</TabsTrigger>
          <TabsTrigger value="expired">{t("tabExpired")}</TabsTrigger>
        </TabsList>

        <TabsContent value={tab} className="mt-6 flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <form onSubmit={handleSearchSubmit} className="space-y-1">
              <Label htmlFor="coupons-search">{t("searchLabel")}</Label>
              <Input
                id="coupons-search"
                name="search"
                defaultValue={filters.search ?? ""}
                placeholder={t("searchPlaceholder")}
                className="h-9 w-64"
              />
            </form>
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                {t("clearFilters")}
              </Button>
            )}
          </div>

          {list.total === 0 ? (
            <EmptyState
              icon={RiCouponLine}
              title={t("noCouponsTitle")}
              description={
                hasFilters
                  ? t("noCouponsFilteredDescription")
                  : t("noCouponsDescription")
              }
            />
          ) : (
            <>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("colCode")}</TableHead>
                      <TableHead>{t("colDiscount")}</TableHead>
                      <TableHead>{t("colRedemptions")}</TableHead>
                      <TableHead>{t("colValidUntil")}</TableHead>
                      <TableHead>{t("colStatus")}</TableHead>
                      <TableHead>{t("colCreated")}</TableHead>
                      <TableHead className="w-24" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.coupons.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>
                          <button
                            type="button"
                            onClick={() => setDetailId(row.id)}
                            className="font-mono font-medium hover:underline"
                          >
                            {row.code}
                          </button>
                          {row.name && (
                            <p className="text-sm text-muted-foreground">
                              {row.name}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          {couponDiscountLabel(row, locale, t)}
                        </TableCell>
                        <TableCell>
                          {row.redemptionCount}
                          {row.maxRedemptions !== null &&
                            ` / ${row.maxRedemptions}`}
                        </TableCell>
                        <TableCell>
                          {formatDate(locale, row.validUntil)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              row.status === "ACTIVE" ? "secondary" : "outline"
                            }
                          >
                            {t(STATUS_LABEL_KEYS[row.status])}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {formatDate(locale, row.createdAt)}
                        </TableCell>
                        <TableCell>
                          {canManage ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={t("view")}
                                >
                                  <RiMoreLine
                                    className="size-4"
                                    aria-hidden="true"
                                  />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={() => setDetailId(row.id)}
                                >
                                  {t("view")}
                                </DropdownMenuItem>
                                {row.status === "ACTIVE" && (
                                  <DropdownMenuItem
                                    onClick={() => setDisableRow(row)}
                                  >
                                    {t("disableTitle")}
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => setDeleteRow(row)}
                                >
                                  {t("deleteTitle")}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setDetailId(row.id)}
                            >
                              {t("view")}
                            </Button>
                          )}
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
        </TabsContent>
      </Tabs>

      {/* Coupon detail dialog, with the redemptions table */}
      {detailId !== null && (
        <CouponsDetailDialog
          couponId={detailId}
          onClose={() => setDetailId(null)}
        />
      )}

      {/* Disable confirmation dialog */}
      <Dialog
        open={disableRow !== null}
        onOpenChange={(next) => {
          if (!next) setDisableRow(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("disableTitle")}</DialogTitle>
            <DialogDescription>{t("disableDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisableRow(null)}>
              {t("disableCancel")}
            </Button>
            <Button
              disabled={disableCoupon.isPending}
              onClick={() => void confirmDisable()}
            >
              {t("disableConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete (soft-disable) confirmation dialog */}
      <Dialog
        open={deleteRow !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteRow(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>{t("deleteDescription")}</DialogDescription>
          </DialogHeader>
          {deleteRow && (
            <p className="text-sm text-muted-foreground">{t("deleteNote")}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteRow(null)}>
              {t("deleteCancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={deleteCoupon.isPending}
              onClick={() => void confirmDelete()}
            >
              {t("deleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
