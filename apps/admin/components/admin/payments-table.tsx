// Payments table (Phase B, plan §3.5 — thin table on the
// trials-table shape).
//
// Server-fed per tab: the page fetches the list, this component
// renders it — with the same columns, status labels, search, provider
// filter, and URL pagination as the other admin tables. The detail
// dialog reads through the payments detail API (usePaymentDetail);
// the refund dialog collects the refund (full / partial + reason)
// and hands off to the shared StepUpDialog, which runs the mutation
// on verification. Single action → ghost link; two actions →
// DropdownMenu (Wave 10, UX-111). The services enforce the refund
// gate server-side regardless — canRefund only hides the button.
//
// A refund records the SendCMS-side effects of a refund the admin
// already issued at the provider: applyRefund makes no provider
// call, and the dialog says so (refundNote).
"use client"

import Link from "next/link"
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
import { RiMoreLine, RiWalletLine } from "@remixicon/react"
import { BILLING_PROVIDERS } from "@sendcms/billing/registry"
import {
  usePaymentDetail,
  useRefundPayment,
  type PaymentRow,
  type PaymentsPage,
} from "@sendcms/billing/queries"
import type { PaymentsQuery } from "@sendcms/billing/validators"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatAmountMinor, formatDate, formatDateTime } from "./plan-format"
import { StepUpDialog } from "./step-up-dialog"

export type PaymentTab = "all" | "succeeded" | "failed" | "refunded"

type Props = {
  initialData: PaymentsPage
  filters: PaymentsQuery
  tab: PaymentTab
  canRefund: boolean
}

const TABS: PaymentTab[] = ["all", "succeeded", "failed", "refunded"]

const KIND_LABEL_KEYS: Record<PaymentRow["kind"], string> = {
  CHECKOUT_COMPLETED: "kindCheckoutCompleted",
  PAYMENT_SUCCEEDED: "kindPaymentSucceeded",
  PAYMENT_FAILED: "kindPaymentFailed",
  PAYMENT_REFUNDED: "kindPaymentRefunded",
  UNMAPPED_PAYMENT: "kindUnmappedPayment",
  ONE_TIME_PURCHASE: "kindOneTimePurchase",
}

const STATUS_LABEL_KEYS: Record<PaymentRow["status"], string> = {
  SUCCEEDED: "statusSucceeded",
  FAILED: "statusFailed",
  REFUNDED: "statusRefunded",
  UNKNOWN: "statusUnknown",
}

function providerLabel(provider: PaymentRow["provider"]): string {
  return BILLING_PROVIDERS.find((p) => p.id === provider)?.label ?? provider
}

export function PaymentsTable({ initialData, filters, tab, canRefund }: Props) {
  const { t } = useTranslation("payments")
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const list = initialData

  const [detailId, setDetailId] = useState<string | null>(null)
  const [refundRow, setRefundRow] = useState<PaymentRow | null>(null)
  const [refundFull, setRefundFull] = useState(true)
  const [refundAmount, setRefundAmount] = useState("")
  const [refundReason, setRefundReason] = useState("")
  const [stepUpOpen, setStepUpOpen] = useState(false)

  const detail = usePaymentDetail(detailId)
  const refund = useRefundPayment()

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
      setParam("tab", nextTab === "all" ? null : nextTab)
    }
  }

  function setPage(page: number) {
    const next = new URLSearchParams(searchParams.toString())
    next.set("page", String(page))
    pushParams(next)
  }

  function clearFilters() {
    const next = new URLSearchParams(searchParams.toString())
    next.delete("q")
    next.delete("provider")
    next.delete("page")
    pushParams(next)
  }

  function handleSearchSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    setParam("q", (data.get("q") as string | null) ?? null)
  }

  const hasFilters = Boolean(filters.provider || filters.q)

  function openRefund(row: PaymentRow) {
    setRefundRow(row)
    setRefundFull(true)
    setRefundAmount("")
    setRefundReason("")
  }

  const parsedAmount = Number.parseFloat(refundAmount)
  const refundValid =
    refundReason.trim() !== "" &&
    (refundFull ||
      (Number.isFinite(parsedAmount) &&
        parsedAmount > 0 &&
        Math.round(parsedAmount * 100) > 0))

  async function confirmRefund() {
    if (!refundRow || !refundValid) return
    const amountMinor = refundFull ? null : Math.round(parsedAmount * 100)
    try {
      await refund.mutateAsync({
        id: refundRow.id,
        input: {
          fullRefund: refundFull,
          amountMinor,
          reason: refundReason.trim(),
        },
      })
      toast.success(t("refundToast"))
      setRefundRow(null)
      router.refresh()
    } catch {
      // The global mutation error toast reports the failure; the
      // dialog stays open so the admin can retry or correct the input.
    }
  }

  const detailData = detail.data ?? null

  return (
    <>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="all">{t("tabAll")}</TabsTrigger>
          <TabsTrigger value="succeeded">{t("tabSucceeded")}</TabsTrigger>
          <TabsTrigger value="failed">{t("tabFailed")}</TabsTrigger>
          <TabsTrigger value="refunded">{t("tabRefunded")}</TabsTrigger>
        </TabsList>

        <TabsContent value={tab} className="mt-6 flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <form onSubmit={handleSearchSubmit} className="space-y-1">
              <Label htmlFor="payments-search">{t("searchLabel")}</Label>
              <Input
                id="payments-search"
                name="q"
                defaultValue={filters.q ?? ""}
                placeholder={t("searchPlaceholder")}
                className="h-9 w-64"
              />
            </form>
            <div className="space-y-1">
              <Label htmlFor="payments-provider-filter">
                {t("providerFilterLabel")}
              </Label>
              <Select
                value={filters.provider ?? "all"}
                onValueChange={(value) =>
                  setParam("provider", value === "all" ? null : value)
                }
              >
                <SelectTrigger
                  id="payments-provider-filter"
                  className="h-9 w-52"
                >
                  <SelectValue placeholder={t("providerAll")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("providerAll")}</SelectItem>
                  {BILLING_PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
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
            <EmptyState
              icon={RiWalletLine}
              title={t("noPaymentsTitle")}
              description={
                hasFilters
                  ? t("noPaymentsFilteredDescription")
                  : t("noPaymentsDescription")
              }
            />
          ) : (
            <>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("colDate")}</TableHead>
                      <TableHead>{t("colCustomer")}</TableHead>
                      <TableHead>{t("colProvider")}</TableHead>
                      <TableHead>{t("colKind")}</TableHead>
                      <TableHead>{t("colAmount")}</TableHead>
                      <TableHead>{t("colStatus")}</TableHead>
                      <TableHead className="w-24" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.payments.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>{formatDateTime(locale, row.at)}</TableCell>
                        <TableCell>
                          {row.userId ? (
                            <Link
                              href={`/admin/all-users/${row.userId}`}
                              className="font-medium hover:underline"
                            >
                              {row.user?.name ?? row.user?.email ?? "—"}
                            </Link>
                          ) : (
                            <span className="font-medium">—</span>
                          )}
                          {row.user?.email && row.user.name && (
                            <p className="text-sm text-muted-foreground">
                              {row.user.email}
                            </p>
                          )}
                          {!row.userId && (
                            <p className="text-sm text-muted-foreground">
                              {t("unknownCustomer")}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>{providerLabel(row.provider)}</TableCell>
                        <TableCell>{t(KIND_LABEL_KEYS[row.kind])}</TableCell>
                        <TableCell>
                          <p
                            className={
                              row.discountAmountMinor !== null &&
                              row.discountAmountMinor > 0
                                ? "text-muted-foreground line-through"
                                : undefined
                            }
                          >
                            {formatAmountMinor(
                              locale,
                              row.discountAmountMinor !== null &&
                                row.discountAmountMinor > 0
                                ? row.fullAmountMinor
                                : row.amountMinor,
                              row.currency,
                              t("amountUnknown")
                            )}
                          </p>
                          {row.discountAmountMinor !== null &&
                            row.discountAmountMinor > 0 &&
                            row.paidAmountMinor !== null && (
                              <p className="text-sm">
                                {t("paidAmount")}:{" "}
                                {formatAmountMinor(
                                  locale,
                                  row.paidAmountMinor,
                                  row.currency,
                                  t("amountUnknown")
                                )}
                              </p>
                            )}
                          {row.amountMinor === null &&
                            row.source === "billing-event" && (
                              <Link
                                href="/admin/billing"
                                className="text-sm text-muted-foreground hover:underline"
                              >
                                {t("viewRawEvent")}
                              </Link>
                            )}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              row.status === "FAILED"
                                ? "destructive"
                                : row.status === "SUCCEEDED"
                                  ? "secondary"
                                  : "outline"
                            }
                          >
                            {t(STATUS_LABEL_KEYS[row.status])}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {canRefund ? (
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
                                <DropdownMenuItem
                                  disabled={row.status === "REFUNDED"}
                                  onClick={() => openRefund(row)}
                                >
                                  {t("refundTitle")}
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

      {/* Payment detail dialog */}
      <Dialog
        open={detailId !== null}
        onOpenChange={(next) => {
          if (!next) setDetailId(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("detailTitle")}</DialogTitle>
          </DialogHeader>
          {detail.isLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : detail.isError || !detailData ? (
            <p className="text-sm text-muted-foreground">
              {t("detailLoadError")}
            </p>
          ) : (
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("detailCustomer")}
                </span>
                <span className="text-right font-medium">
                  {detailData.payment.user?.name ??
                    detailData.payment.user?.email ??
                    t("unknownCustomer")}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("detailProvider")}
                </span>
                <span>{providerLabel(detailData.payment.provider)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t("detailKind")}</span>
                <span>{t(KIND_LABEL_KEYS[detailData.payment.kind])}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("detailStatus")}
                </span>
                <span>{t(STATUS_LABEL_KEYS[detailData.payment.status])}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("detailAmount")}
                </span>
                <span
                  className={
                    detailData.payment.discountAmountMinor !== null &&
                    detailData.payment.discountAmountMinor > 0
                      ? "font-medium text-muted-foreground line-through"
                      : "font-medium"
                  }
                >
                  {formatAmountMinor(
                    locale,
                    detailData.payment.discountAmountMinor !== null &&
                      detailData.payment.discountAmountMinor > 0
                      ? detailData.payment.fullAmountMinor
                      : detailData.payment.amountMinor,
                    detailData.payment.currency,
                    t("amountUnknown")
                  )}
                </span>
              </div>
              {detailData.payment.discountAmountMinor !== null &&
                detailData.payment.discountAmountMinor > 0 &&
                detailData.payment.paidAmountMinor !== null && (
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">
                      {t("paidAmount")}
                    </span>
                    <span className="font-medium">
                      {formatAmountMinor(
                        locale,
                        detailData.payment.paidAmountMinor,
                        detailData.payment.currency,
                        t("amountUnknown")
                      )}
                    </span>
                  </div>
                )}
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t("detailDate")}</span>
                <span>{formatDateTime(locale, detailData.payment.at)}</span>
              </div>
              {detailData.event && (
                <>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">
                      {t("detailEventType")}
                    </span>
                    <span className="font-mono text-xs">
                      {detailData.event.eventType}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">
                      {t("detailProviderEventId")}
                    </span>
                    <span className="font-mono text-xs">
                      {detailData.event.providerEventId}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">
                      {t("detailProcessed")}
                    </span>
                    <span>
                      {detailData.event.processedAt
                        ? t("detailProcessedYes")
                        : t("detailProcessedNo")}
                    </span>
                  </div>
                </>
              )}
              {detailData.purchase && (
                <>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">
                      {t("detailProviderReference")}
                    </span>
                    <span className="font-mono text-xs">
                      {detailData.purchase.providerReference}
                    </span>
                  </div>
                  {detailData.purchase.checkoutId && (
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">
                        {t("detailCheckoutId")}
                      </span>
                      <span className="font-mono text-xs">
                        {detailData.purchase.checkoutId}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">
                      {t("detailAccessStart")}
                    </span>
                    <span>
                      {formatDate(locale, detailData.purchase.accessStart)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">
                      {t("detailAccessEnd")}
                    </span>
                    <span>
                      {formatDate(locale, detailData.purchase.accessEnd)}
                    </span>
                  </div>
                </>
              )}
              {detailData.subscription && (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">
                    {t("detailSubscription")}
                  </span>
                  <span>
                    {detailData.subscription.planName ?? "—"} ·{" "}
                    {detailData.subscription.status}
                  </span>
                </div>
              )}
              <div className="flex flex-wrap gap-4 pt-2">
                {detailData.event && (
                  <Button asChild variant="outline" size="sm">
                    <Link href="/admin/billing">{t("viewRawEvent")}</Link>
                  </Button>
                )}
                {detailData.subscription && detailData.payment.userId && (
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href={`/admin/all-users/${detailData.payment.userId}`}
                    >
                      {t("viewSubscription")}
                    </Link>
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Refund confirmation dialog */}
      <Dialog
        open={refundRow !== null}
        onOpenChange={(next) => {
          if (!next) setRefundRow(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("refundTitle")}</DialogTitle>
            <DialogDescription>{t("refundDescription")}</DialogDescription>
          </DialogHeader>
          {refundRow && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">{t("refundNote")}</p>
              <div className="flex justify-between gap-4 text-sm">
                <span className="text-muted-foreground">
                  {t("detailAmount")}
                </span>
                <span className="font-medium">
                  {formatAmountMinor(
                    locale,
                    refundRow.amountMinor,
                    refundRow.currency,
                    t("amountUnknown")
                  )}
                </span>
              </div>
              <div className="space-y-1">
                <Label htmlFor="payments-refund-type">{t("refundTitle")}</Label>
                <Select
                  value={refundFull ? "full" : "partial"}
                  onValueChange={(value) => setRefundFull(value === "full")}
                >
                  <SelectTrigger
                    id="payments-refund-type"
                    className="h-9 w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full">{t("refundFull")}</SelectItem>
                    <SelectItem value="partial">
                      {t("refundPartial")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {!refundFull && (
                <div className="space-y-1">
                  <Label htmlFor="payments-refund-amount">
                    {t("refundAmountLabel")}
                  </Label>
                  <Input
                    id="payments-refund-amount"
                    inputMode="decimal"
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                    placeholder={t("refundAmountPlaceholder")}
                    className="h-9"
                  />
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="payments-refund-reason">
                  {t("refundReasonLabel")}
                </Label>
                <Input
                  id="payments-refund-reason"
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  className="h-9"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRefundRow(null)}>
              {t("refundCancel")}
            </Button>
            <Button
              disabled={!refundValid || refund.isPending}
              onClick={() => setStepUpOpen(true)}
            >
              {t("refundContinue")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Step-up: the refund runs only after the password re-entry. */}
      <StepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => void confirmRefund()}
      />
    </>
  )
}
