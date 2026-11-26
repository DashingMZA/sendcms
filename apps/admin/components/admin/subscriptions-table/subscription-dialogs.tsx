// Subscription dialogs (Wave 10, SRC-118 split of
// subscriptions-table.tsx): assign a user to a plan version, and cancel
// a subscription (immediately or at period end).
"use client"

import { useRef, useState } from "react"
import { toast } from "sonner"
import { RiCloseLine, RiSearchLine } from "@remixicon/react"
import { useAdminUsers } from "@sendcms/admin-users/queries"
import {
  useAssignSubscription,
  useCancelSubscription,
  usePlans,
} from "@sendcms/plans/queries"
import {
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
  Textarea,
} from "@sendcms/ui"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatPrice } from "../plan-format"

const DEBOUNCE_MS = 300

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
  const locale = useLocale()
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[42rem]">
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
                    <RiCloseLine className="size-4" aria-hidden="true" />
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className="relative">
                  <RiSearchLine className="absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="assign-user-search"
                    placeholder={t("assignUserPlaceholder")}
                    value={search}
                    onChange={(e) => handleSearchChange(e.target.value)}
                    className="ps-9"
                  />
                </div>
                {users.length > 0 && (
                  <div className="rounded-lg border">
                    {users.map((user) => (
                      <button
                        key={user.id}
                        type="button"
                        onClick={() => setSelectedUser(user)}
                        className="flex w-full flex-col px-3 py-2 text-start hover:bg-accent"
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
                          locale,
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
