"use client"

import { useCallback, useRef, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Search, X } from "lucide-react"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import {
  useCreatePlan,
  usePlans,
  type PlanListQuery,
  type PlansListResponse,
} from "@sendcms/plans/queries"
import { FREE_PLAN_V1_ENTITLEMENTS } from "@sendcms/plans/validators"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@sendcms/ui"
import { RiPriceTag3Line } from "@remixicon/react"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDate, formatPrice } from "./plan-format"
import {
  PlanVersionForm,
  type PlanVersionFormValues,
} from "./plan-version-form"

const DEBOUNCE_MS = 300

type Props = {
  initialData: PlansListResponse
  filters: PlanListQuery
  actorRole: PlatformRole | AdminRole
}

export function PlansTable({ initialData, filters, actorRole }: Props) {
  const { t } = useTranslation("plans")
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [createOpen, setCreateOpen] = useState(false)

  const { data } = usePlans(filters, initialData)
  const list = data ?? initialData

  const canManage = adminCan(actorRole, "MANAGE_PLANS")

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

  const hasFilters = Boolean(filters.q || filters.status || filters.kind)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <PlansSearchInput defaultValue={filters.q ?? ""} />
          <div className="space-y-1">
            <Label htmlFor="plans-status-filter">
              {t("statusFilterLabel")}
            </Label>
            <Select
              value={filters.status ?? "all"}
              onValueChange={(value) =>
                setParam("status", value === "all" ? null : value)
              }
            >
              <SelectTrigger id="plans-status-filter" className="h-9 w-44">
                <SelectValue placeholder={t("statusAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("statusAll")}</SelectItem>
                <SelectItem value="DRAFT">{t("statusDraft")}</SelectItem>
                <SelectItem value="PUBLISHED">
                  {t("statusPublished")}
                </SelectItem>
                <SelectItem value="ARCHIVED">{t("statusArchived")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="plans-kind-filter">{t("kindFilterLabel")}</Label>
            <Select
              value={filters.kind ?? "all"}
              onValueChange={(value) =>
                setParam("kind", value === "all" ? null : value)
              }
            >
              <SelectTrigger id="plans-kind-filter" className="h-9 w-44">
                <SelectValue placeholder={t("kindAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("kindAll")}</SelectItem>
                <SelectItem value="FREE">{t("kindFree")}</SelectItem>
                <SelectItem value="PAID">{t("kindPaid")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              {t("clearFilters")}
            </Button>
          )}
        </div>
        {canManage && (
          <Button onClick={() => setCreateOpen(true)}>{t("newPlan")}</Button>
        )}
      </div>

      {list.total === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-20 text-center">
          <RiPriceTag3Line
            className="mb-4 size-10 text-muted-foreground"
            aria-hidden="true"
          />
          <h3 className="mb-1 text-lg font-semibold text-balance">
            {t("noPlansTitle")}
          </h3>
          <p className="max-w-sm text-sm text-muted-foreground">
            {hasFilters
              ? t("noPlansDescription")
              : t("noPlansEmptyDescription")}
          </p>
          {canManage && !hasFilters && (
            <Button className="mt-4" onClick={() => setCreateOpen(true)}>
              {t("newPlan")}
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colPlan")}</TableHead>
                  <TableHead>{t("colKind")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead>{t("colVersion")}</TableHead>
                  <TableHead>{t("colPrice")}</TableHead>
                  <TableHead>{t("colVersions")}</TableHead>
                  <TableHead>{t("colSubscriptions")}</TableHead>
                  <TableHead>{t("colCreated")}</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.plans.map((plan) => (
                  <TableRow key={plan.id}>
                    <TableCell>
                      <p className="font-medium">{plan.name}</p>
                      <p className="font-mono text-sm text-muted-foreground">
                        {plan.slug}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {plan.kind === "FREE" ? t("kindFree") : t("kindPaid")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          plan.status === "PUBLISHED" ? "secondary" : "outline"
                        }
                      >
                        {plan.status === "DRAFT"
                          ? t("statusDraft")
                          : plan.status === "PUBLISHED"
                            ? t("statusPublished")
                            : t("statusArchived")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {plan.currentVersion
                        ? `v${plan.currentVersion.version}`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {plan.currentVersion
                        ? formatPrice(
                            locale,
                            plan.currentVersion.priceAmount,
                            plan.currentVersion.priceCurrency,
                            t("priceFree")
                          )
                        : "—"}
                    </TableCell>
                    <TableCell>{plan.versionCount}</TableCell>
                    <TableCell>{plan.subscriptionCount}</TableCell>
                    <TableCell>{formatDate(locale, plan.createdAt)}</TableCell>
                    <TableCell>
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/admin/plans/${plan.id}`}>
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

      {createOpen && (
        <CreatePlanDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(planId) => {
            setCreateOpen(false)
            router.push(`/admin/plans/${planId}`)
          }}
        />
      )}
    </div>
  )
}

/** Debounced search over name/slug (URL param `q`), same shape as the
    users table. Resets to page 1 on change. */
function PlansSearchInput({ defaultValue = "" }: { defaultValue?: string }) {
  const { t } = useTranslation("plans")
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
      <Search className="absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="text"
        placeholder={t("searchPlaceholder")}
        value={value}
        onChange={handleChange}
        className="h-9 w-64 ps-9 pe-9 text-sm"
      />
      {value && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute end-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
          aria-label={t("clearFilters")}
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}

function CreatePlanDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (planId: string) => void
}) {
  const { t } = useTranslation("plans")
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [description, setDescription] = useState("")
  const [kind, setKind] = useState<"FREE" | "PAID">("FREE")
  const [isPrivate, setIsPrivate] = useState(false)
  const [changeReason, setChangeReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const createPlan = useCreatePlan()

  async function handleSubmit(values: PlanVersionFormValues) {
    setError(null)
    if (!name.trim() || !slug.trim()) {
      setError(t("nameLabel"))
      return
    }
    try {
      const plan = await createPlan.mutateAsync({
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim() || undefined,
        kind,
        isPrivate,
        priceAmount: values.priceAmount,
        priceCurrency: values.priceCurrency,
        billingInterval: values.billingInterval,
        trialDays: values.trialDays,
        entitlements: values.entitlements,
        changeReason: changeReason.trim() || undefined,
      })
      toast.success(t("toastCreated"))
      onCreated(plan.id)
    } catch {
      // The query provider's global mutation error toast already shows
      // the failure — the dialog stays open so the admin can retry.
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
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="plan-create-name">{t("nameLabel")}</Label>
              <Input
                id="plan-create-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("namePlaceholder")}
                maxLength={100}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="plan-create-slug">{t("slugLabel")}</Label>
              <Input
                id="plan-create-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder={t("slugPlaceholder")}
                maxLength={100}
              />
              <p className="text-xs text-muted-foreground">{t("slugHint")}</p>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="plan-create-description">
              {t("descriptionLabel")}
            </Label>
            <Textarea
              id="plan-create-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
              maxLength={500}
              rows={2}
            />
          </div>
          <div className="flex flex-wrap items-center gap-6">
            <div className="space-y-1">
              <Label htmlFor="plan-create-kind">{t("kindLabel")}</Label>
              <Select
                value={kind}
                onValueChange={(value) => setKind(value as "FREE" | "PAID")}
              >
                <SelectTrigger id="plan-create-kind" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FREE">{t("kindFreeLabel")}</SelectItem>
                  <SelectItem value="PAID">{t("kindPaidLabel")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 pt-5 text-sm">
              <Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
              {t("privateLabel")}
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("privateDescription")}
          </p>
          <div className="space-y-1">
            <Label htmlFor="plan-create-reason">{t("changeReasonLabel")}</Label>
            <Textarea
              id="plan-create-reason"
              value={changeReason}
              onChange={(e) => setChangeReason(e.target.value)}
              placeholder={t("changeReasonPlaceholder")}
              maxLength={500}
              rows={2}
            />
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <PlanVersionForm
          initial={{
            priceAmount: null,
            priceCurrency: "USD",
            billingInterval: "MONTHLY",
            trialDays: 0,
            entitlements: FREE_PLAN_V1_ENTITLEMENTS,
          }}
          onSubmit={handleSubmit}
          onCancel={onClose}
          submitLabel={t("createSubmit")}
          pending={createPlan.isPending}
        />
      </DialogContent>
    </Dialog>
  )
}
