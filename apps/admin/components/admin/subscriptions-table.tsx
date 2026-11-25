"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Search, X } from "lucide-react"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import { useAdminUsers } from "@sendcms/admin-users/queries"
import {
  useAssignSubscription,
  useCancelSubscription,
  usePlans,
  useSubscriptions,
  type SubscriptionListQuery,
  type SubscriptionsListResponse,
} from "@sendcms/plans/queries"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
  Textarea,
} from "@sendcms/ui"
import { RiRepeatLine } from "@remixicon/react"
import { useTranslation } from "@/components/admin/translation-provider"
import { formatDate, formatPrice } from "./plan-format"

const DEBOUNCE_MS = 300

type Props = {
  initialData: SubscriptionsListResponse
  filters: SubscriptionListQuery
  actorRole: PlatformRole | AdminRole
}

export function SubscriptionsTable({ initialData, filters, actorRole }: Props) {
  const { t } = useTranslation("subscriptions")
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [assignOpen, setAssignOpen] = useState(false)
  const [cancelId, setCancelId] = useState<string | null>(null)

  const { data } = useSubscriptions(filters, initialData)
  const list = data ?? initialData

  const { data: plansData } = usePlans({
    page: 1,
    perPage: 100,
    sort: "createdAt:desc",
  })
  const plans = plansData?.plans ?? []

  const canManage = adminCan(actorRole, "MANAGE_SUBSCRIPTIONS")

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

  const hasFilters = Boolean(filters.status || filters.planId || filters.q)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          {/* ADM-032: the search box — debounced, URL-as-state (`q`),
              now actually filtering server-side by subscriber
              name/email instead of refetching the same list. */}
          <SubscriptionsSearchInput defaultValue={filters.q ?? ""} />
          <div className="space-y-1">
            <Label htmlFor="subscriptions-status-filter">
              {t("statusFilterLabel")}
            </Label>
            <Select
              value={filters.status ?? "all"}
              onValueChange={(value) =>
                setParam("status", value === "all" ? null : value)
              }
            >
              <SelectTrigger
                id="subscriptions-status-filter"
                className="h-9 w-44"
              >
                <SelectValue placeholder={t("statusAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("statusAll")}</SelectItem>
                <SelectItem value="ACTIVE">{t("statusActive")}</SelectItem>
                <SelectItem value="TRIALING">{t("statusTrialing")}</SelectItem>
                <SelectItem value="PAST_DUE">{t("statusPastDue")}</SelectItem>
                <SelectItem value="CANCELED">{t("statusCanceled")}</SelectItem>
                <SelectItem value="EXPIRED">{t("statusExpired")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="subscriptions-plan-filter">
              {t("planFilterLabel")}
            </Label>
            <Select
              value={filters.planId ?? "all"}
              onValueChange={(value) =>
                setParam("planId", value === "all" ? null : value)
              }
            >
              <SelectTrigger
                id="subscriptions-plan-filter"
                className="h-9 w-52"
              >
                <SelectValue placeholder={t("planAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("planAll")}</SelectItem>
                {plans.map((plan) => (
                  <SelectItem key={plan.id} value={plan.id}>
                    {plan.name}
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
        <div className="flex flex-wrap gap-2">
          {adminCan(actorRole, "MIGRATE_SUBSCRIPTIONS") && (
            <Button asChild variant="outline">
              <Link href="/admin/subscriptions/migrate">
                {t("migrateTitle")}
              </Link>
            </Button>
          )}
          {canManage && (
            <Button onClick={() => setAssignOpen(true)}>{t("assign")}</Button>
          )}
        </div>
      </div>

      {list.total === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-20 text-center">
          <RiRepeatLine
            className="mb-4 size-10 text-muted-foreground"
            aria-hidden="true"
          />
          <h3 className="mb-1 text-lg font-semibold text-balance">
            {t("noSubscriptionsTitle")}
          </h3>
          <p className="max-w-sm text-sm text-muted-foreground">
            {hasFilters
              ? t("noSubscriptionsDescription")
              : t("noSubscriptionsEmptyDescription")}
          </p>
          {canManage && !hasFilters && (
            <Button className="mt-4" onClick={() => setAssignOpen(true)}>
              {t("assign")}
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colUser")}</TableHead>
                  <TableHead>{t("colPlan")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead>{t("colPeriod")}</TableHead>
                  <TableHead>{t("colCancelAtEnd")}</TableHead>
                  <TableHead>{t("colCreated")}</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.subscriptions.map((subscription) => (
                  <TableRow key={subscription.id}>
                    <TableCell>
                      <p className="font-medium">
                        {subscription.user.name ?? "—"}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {subscription.user.email}
                      </p>
                    </TableCell>
                    <TableCell>
                      <p className="font-medium">{subscription.plan.name}</p>
                      <p className="text-sm text-muted-foreground">
                        v{subscription.planVersion.version}
                        {subscription.planVersion.priceAmount !== null &&
                          ` · ${formatPrice(
                            subscription.planVersion.priceAmount,
                            subscription.planVersion.priceCurrency,
                            ""
                          )}`}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          subscription.status === "ACTIVE" ||
                          subscription.status === "TRIALING"
                            ? "secondary"
                            : "outline"
                        }
                      >
                        {subscriptionStatusLabel(subscription.status, t)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {subscription.currentPeriodStart
                        ? `${formatDate(subscription.currentPeriodStart)} → ${formatDate(subscription.currentPeriodEnd)}`
                        : t("periodNone")}
                    </TableCell>
                    <TableCell>
                      {subscription.cancelAtPeriodEnd
                        ? t("cancelAtEndYes")
                        : t("cancelAtEndNo")}
                    </TableCell>
                    <TableCell>{formatDate(subscription.createdAt)}</TableCell>
                    <TableCell>
                      {canManage &&
                        (subscription.status === "ACTIVE" ||
                          subscription.status === "TRIALING") && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setCancelId(subscription.id)}
                          >
                            {t("cancel")}
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

      {assignOpen && <AssignDialog onClose={() => setAssignOpen(false)} />}
      {cancelId && (
        <CancelDialog
          subscriptionId={cancelId}
          onClose={() => setCancelId(null)}
        />
      )}
    </div>
  )
}

/** Debounced search over subscriber name/email (URL param `q`), same
    shape as the users table's search input. Resets to page 1. */
function SubscriptionsSearchInput({
  defaultValue = "",
}: {
  defaultValue?: string
}) {
  const { t } = useTranslation("subscriptions")
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [value, setValue] = useState(defaultValue)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function updateSearch(search: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (search.trim()) {
      params.set("q", search.trim())
    } else {
      params.delete("q")
    }
    params.delete("page")
    const text = params.toString()
    router.push(text ? `${pathname}?${text}` : pathname)
  }

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

export function subscriptionStatusLabel(
  status: string,
  t: (key: string) => string
): string {
  switch (status) {
    case "ACTIVE":
      return t("statusActive")
    case "TRIALING":
      return t("statusTrialing")
    case "PAST_DUE":
      return t("statusPastDue")
    case "CANCELED":
      return t("statusCanceled")
    case "EXPIRED":
      return t("statusExpired")
    default:
      return status
  }
}

export function AssignDialog({
  onClose,
  preselectedUser,
}: {
  onClose: () => void
  // When set, the user is fixed (e.g. from the user detail page) and
  // the search step is skipped.
  preselectedUser?: { id: string; name: string | null; email: string }
}) {
  const { t } = useTranslation("subscriptions")
  const { t: tPlans } = useTranslation("plans")
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [selectedUser, setSelectedUser] = useState<{
    id: string
    name: string | null
    email: string
  } | null>(preselectedUser ?? null)
  const [planVersionId, setPlanVersionId] = useState("")
  const [reason, setReason] = useState("")
  const assign = useAssignSubscription()

  const { data: usersData } = useAdminUsers({
    q: debouncedSearch || undefined,
    page: 1,
    perPage: 10,
    sort: "createdAt:desc",
  })
  const users = usersData?.users ?? []

  const { data: plansData } = usePlans({
    page: 1,
    perPage: 100,
    sort: "createdAt:desc",
  })
  // Only plans with a published (current) version can be assigned.
  const assignable = (plansData?.plans ?? []).filter(
    (plan) => plan.currentVersion !== null
  )

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function handleSearchChange(value: string) {
    setSearch(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(
      () => setDebouncedSearch(value.trim()),
      DEBOUNCE_MS
    )
  }

  async function confirm() {
    if (!selectedUser || !planVersionId || !reason.trim()) return
    try {
      await assign.mutateAsync({
        userId: selectedUser.id,
        planVersionId,
        reason: reason.trim(),
      })
      toast.success(t("toastAssigned"))
      onClose()
    } catch {
      // Global mutation error toast already shown.
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("assignTitle")}</DialogTitle>
          <DialogDescription>{t("assignDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="space-y-1">
            <Label htmlFor="assign-user-search">{t("assignUserLabel")}</Label>
            {selectedUser ? (
              <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                <div>
                  <p className="text-sm font-medium">
                    {selectedUser.name ?? "—"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {selectedUser.email}
                  </p>
                </div>
                {!preselectedUser && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedUser(null)}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="assign-user-search"
                    placeholder={t("assignUserPlaceholder")}
                    value={search}
                    onChange={(e) => handleSearchChange(e.target.value)}
                    className="pl-9"
                  />
                </div>
                {users.length > 0 && (
                  <div className="rounded-lg border">
                    {users.map((user) => (
                      <button
                        key={user.id}
                        type="button"
                        onClick={() => setSelectedUser(user)}
                        className="flex w-full flex-col px-3 py-2 text-left hover:bg-accent"
                      >
                        <span className="text-sm font-medium">
                          {user.name ?? "—"}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {user.email}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="assign-plan">{t("assignPlanLabel")}</Label>
            {assignable.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("assignNoPlans")}
              </p>
            ) : (
              <Select value={planVersionId} onValueChange={setPlanVersionId}>
                <SelectTrigger id="assign-plan">
                  <SelectValue placeholder={t("assignPlanPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {assignable.map((plan) => (
                    <SelectItem
                      key={plan.currentVersion!.id}
                      value={plan.currentVersion!.id}
                    >
                      {plan.name} v{plan.currentVersion!.version}
                      {plan.currentVersion!.priceAmount !== null &&
                        ` · ${formatPrice(
                          plan.currentVersion!.priceAmount,
                          plan.currentVersion!.priceCurrency,
                          tPlans("priceFree")
                        )}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="assign-reason">{t("assignReasonLabel")}</Label>
            <Textarea
              id="assign-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("assignReasonPlaceholder")}
              maxLength={500}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            onClick={confirm}
            disabled={
              assign.isPending ||
              !selectedUser ||
              !planVersionId ||
              reason.trim() === ""
            }
          >
            {t("assignSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function CancelDialog({
  subscriptionId,
  onClose,
}: {
  subscriptionId: string
  onClose: () => void
}) {
  const { t } = useTranslation("subscriptions")
  const [mode, setMode] = useState<"immediate" | "periodEnd">("periodEnd")
  const [reason, setReason] = useState("")
  const cancel = useCancelSubscription(subscriptionId)

  async function confirm() {
    try {
      await cancel.mutateAsync({
        cancelAtPeriodEnd: mode === "periodEnd",
        reason: reason.trim() || undefined,
      })
      toast.success(t("toastCanceled"))
      onClose()
    } catch {
      // Global mutation error toast already shown.
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("cancelTitle")}</DialogTitle>
          <DialogDescription>{t("cancelDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="space-y-1">
            <Label htmlFor="cancel-mode">{t("cancelTitle")}</Label>
            <Select
              value={mode}
              onValueChange={(value) =>
                setMode(value as "immediate" | "periodEnd")
              }
            >
              <SelectTrigger id="cancel-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="periodEnd">
                  {t("cancelAtPeriodEnd")}
                </SelectItem>
                <SelectItem value="immediate">
                  {t("cancelImmediate")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cancel-reason">{t("cancelReasonLabel")}</Label>
            <Textarea
              id="cancel-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("cancelReasonPlaceholder")}
              maxLength={500}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={confirm}
            disabled={cancel.isPending}
          >
            {t("cancelSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
