"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import {
  useEntitlementOverrides,
  useRemoveEntitlementOverride,
  useSetEntitlementOverride,
  useSubscription,
  useUserSubscription,
} from "@sendcms/plans/queries"
import type { UsageMeter } from "@sendcms/plans/validators"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
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
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@sendcms/ui"
import { RiInformationLine, RiPriceTag3Line } from "@remixicon/react"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDate, formatDateTime } from "./plan-format"
import {
  AssignDialog,
  CancelDialog,
  subscriptionStatusLabel,
} from "./subscriptions-table"

const ALL_METERS: UsageMeter[] = [
  "FORMS",
  "DOMAINS",
  "SUBMISSIONS",
  "API_KEYS",
  "MCP_REQUESTS",
  "AI_REQUESTS",
]

// API key and MCP request limits can never be unlimited (the service
// rejects a null value for them) — the unlimited checkbox is disabled
// for those two meters.
const NEVER_UNLIMITED: UsageMeter[] = ["API_KEYS", "MCP_REQUESTS"]

type Props = {
  userId: string
  userName: string | null
  userEmail: string
  actorRole: PlatformRole | AdminRole
}

/**
 * The user detail's Package & subscription tab (Phase 4 — real, not
 * planned): the active subscription with assign/change/cancel, the
 * per-meter entitlement overrides, and the subscription event history.
 */
export function UserPackageTab({
  userId,
  userName,
  userEmail,
  actorRole,
}: Props) {
  const { t } = useTranslation("subscriptions")
  const locale = useLocale()
  const [assignOpen, setAssignOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [overrideOpen, setOverrideOpen] = useState(false)

  const {
    data: subscription,
    isPending: subscriptionPending,
    isError: subscriptionError,
    refetch: refetchSubscription,
  } = useUserSubscription(userId)
  const {
    data: overridesData,
    isPending: overridesPending,
    isError: overridesError,
  } = useEntitlementOverrides(userId, {
    page: 1,
    perPage: 20,
  })
  const overrides = overridesData?.overrides ?? []

  const canManageSubs = adminCan(actorRole, "MANAGE_SUBSCRIPTIONS")
  const canManageUsage = adminCan(actorRole, "MANAGE_USAGE")

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("currentSubscription")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* ADM-035: while loading a skeleton, on failure an error
              state — never the false "No active subscription" empty
              state for a user who has one. */}
          {subscriptionPending ? (
            <Skeleton className="h-48 w-full" />
          ) : subscriptionError ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm"
            >
              <span>{t("loadError")}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetchSubscription()}
              >
                {t("retry")}
              </Button>
            </div>
          ) : !subscription ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
              <RiPriceTag3Line
                className="mb-4 size-10 text-muted-foreground"
                aria-hidden="true"
              />
              <h3 className="mb-1 text-lg font-semibold text-balance">
                {t("noSubscriptionTitle")}
              </h3>
              <p className="max-w-sm text-sm text-muted-foreground">
                {t("noSubscriptionDescription")}
              </p>
              {canManageSubs && (
                <Button className="mt-4" onClick={() => setAssignOpen(true)}>
                  {t("assignSubscription")}
                </Button>
              )}
            </div>
          ) : (
            <>
              <dl className="divide-y">
                <Field label={t("planLabel")}>
                  {subscription.plan.name} · v{subscription.planVersion.version}
                </Field>
                <Field label={t("statusLabel")}>
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
                </Field>
                <Field label={t("periodStartLabel")}>
                  {formatDateTime(locale, subscription.currentPeriodStart)}
                </Field>
                <Field label={t("periodEndLabel")}>
                  {formatDateTime(locale, subscription.currentPeriodEnd)}
                </Field>
                <Field label={t("cancelAtPeriodEndLabel")}>
                  {subscription.cancelAtPeriodEnd
                    ? t("cancelAtEndYes")
                    : t("cancelAtEndNo")}
                </Field>
              </dl>
              {/* ADM-037: the plan's limits, alongside the
                  subscription and overrides — effective entitlements
                  (ADM-036: overrides already merged in), so what the
                  admin sees is what the user is actually allowed. */}
              <div className="rounded-lg border px-4 py-3">
                <h3 className="mb-2 text-sm font-semibold">
                  {t("limitsTitle")}
                </h3>
                {subscription.entitlements === null ? (
                  <p className="text-sm text-muted-foreground">
                    {t("limitsUnavailable")}
                  </p>
                ) : (
                  <dl className="flex flex-col gap-1 text-sm">
                    <LimitRow
                      label={meterLabel("FORMS", t)}
                      value={subscription.entitlements.forms}
                      t={t}
                    />
                    <LimitRow
                      label={meterLabel("DOMAINS", t)}
                      value={subscription.entitlements.domains}
                      t={t}
                    />
                    <LimitRow
                      label={meterLabel("SUBMISSIONS", t)}
                      value={subscription.entitlements.submissionsPerMonth}
                      t={t}
                    />
                    <LimitRow
                      label={meterLabel("API_KEYS", t)}
                      value={subscription.entitlements.apiKeys}
                      t={t}
                    />
                    <LimitRow
                      label={meterLabel("MCP_REQUESTS", t)}
                      value={subscription.entitlements.mcpRequestsPerHour}
                      t={t}
                    />
                    <LimitRow
                      label={meterLabel("AI_REQUESTS", t)}
                      value={subscription.entitlements.aiRequestsPerDay}
                      t={t}
                    />
                  </dl>
                )}
              </div>
              {canManageSubs && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setAssignOpen(true)}>
                    {t("changeSubscription")}
                  </Button>
                  {(subscription.status === "ACTIVE" ||
                    subscription.status === "TRIALING") && (
                    <Button
                      variant="outline"
                      onClick={() => setCancelOpen(true)}
                    >
                      {t("cancelSubscription")}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("overridesTitle")}</CardTitle>
          <CardDescription>{t("overridesDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* ADM-035: the overrides list is empty only once it has
              loaded — a pending or failed fetch is not "no overrides". */}
          {overridesPending ? (
            <Skeleton className="h-32 w-full" />
          ) : overridesError ? (
            <p role="alert" className="text-sm text-destructive">
              {t("loadError")}
            </p>
          ) : overrides.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
              <RiInformationLine
                className="mb-4 size-10 text-muted-foreground"
                aria-hidden="true"
              />
              <h3 className="mb-1 text-lg font-semibold text-balance">
                {t("overridesEmptyTitle")}
              </h3>
              <p className="max-w-sm text-sm text-muted-foreground">
                {t("overridesEmptyDescription")}
              </p>
            </div>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("overrideMeter")}</TableHead>
                    <TableHead>{t("overrideValue")}</TableHead>
                    <TableHead>{t("overrideReason")}</TableHead>
                    <TableHead>{t("overrideExpires")}</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overrides.map((override) => (
                    <OverrideRow
                      key={override.id}
                      userId={userId}
                      meter={override.meter}
                      value={override.value}
                      reason={override.reason}
                      expiresAt={override.expiresAt}
                      canRemove={canManageUsage}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {canManageUsage && (
            <div>
              <Button variant="outline" onClick={() => setOverrideOpen(true)}>
                {t("setOverride")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle as="h2">{t("historyTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {/* ADM-035: same loading/error gate as the subscription
              card — the history empty state is only true once the
              subscription has loaded and there is none. */}
          {subscriptionPending ? (
            <Skeleton className="h-32 w-full" />
          ) : subscriptionError ? (
            <p role="alert" className="text-sm text-destructive">
              {t("loadError")}
            </p>
          ) : !subscription ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
              <RiInformationLine
                className="mb-4 size-10 text-muted-foreground"
                aria-hidden="true"
              />
              <h3 className="mb-1 text-lg font-semibold text-balance">
                {t("historyEmptyTitle")}
              </h3>
              <p className="max-w-sm text-sm text-muted-foreground">
                {t("historyEmptyDescription")}
              </p>
            </div>
          ) : (
            <SubscriptionHistory subscriptionId={subscription.id} />
          )}
        </CardContent>
      </Card>

      {assignOpen && (
        <AssignDialog
          onClose={() => setAssignOpen(false)}
          preselectedUser={{ id: userId, name: userName, email: userEmail }}
        />
      )}
      {cancelOpen && subscription && (
        <CancelDialog
          subscriptionId={subscription.id}
          onClose={() => setCancelOpen(false)}
        />
      )}
      {overrideOpen && (
        <SetOverrideDialog
          userId={userId}
          onClose={() => setOverrideOpen(false)}
        />
      )}
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  )
}

/** One effective plan limit (ADM-037): null means unlimited. */
function LimitRow({
  label,
  value,
  t,
}: {
  label: string
  value: number | null
  t: (key: string) => string
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">
        {value === null ? t("unlimited") : value}
      </dd>
    </div>
  )
}

function meterLabel(meter: UsageMeter, t: (key: string) => string): string {
  switch (meter) {
    case "FORMS":
      return t("meterForms")
    case "DOMAINS":
      return t("meterDomains")
    case "SUBMISSIONS":
      return t("meterSubmissions")
    case "API_KEYS":
      return t("meterApiKeys")
    case "MCP_REQUESTS":
      return t("meterMcpRequests")
    case "AI_REQUESTS":
      return t("meterAiRequests")
    default:
      return meter
  }
}

function OverrideRow({
  userId,
  meter,
  value,
  reason,
  expiresAt,
  canRemove,
}: {
  userId: string
  meter: UsageMeter
  value: number | null
  reason: string
  expiresAt: Date | null
  canRemove: boolean
}) {
  const { t } = useTranslation("subscriptions")
  const locale = useLocale()
  const remove = useRemoveEntitlementOverride(userId)

  async function handleRemove() {
    try {
      await remove.mutateAsync(meter)
      toast.success(t("toastOverrideRemoved"))
    } catch {
      // Global mutation error toast already shown.
    }
  }

  return (
    <TableRow>
      <TableCell className="font-medium">{meterLabel(meter, t)}</TableCell>
      <TableCell>{value === null ? t("unlimited") : value}</TableCell>
      <TableCell className="max-w-48 truncate" title={reason}>
        {reason}
      </TableCell>
      <TableCell>{formatDate(locale, expiresAt)}</TableCell>
      <TableCell>
        {canRemove && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRemove}
            disabled={remove.isPending}
          >
            {t("overrideRemove")}
          </Button>
        )}
      </TableCell>
    </TableRow>
  )
}

function SetOverrideDialog({
  userId,
  onClose,
}: {
  userId: string
  onClose: () => void
}) {
  const { t } = useTranslation("subscriptions")
  const [meter, setMeter] = useState<UsageMeter>("FORMS")
  const [value, setValue] = useState("")
  const [unlimited, setUnlimited] = useState(false)
  const [reason, setReason] = useState("")
  const [expiresAt, setExpiresAt] = useState("")
  const setOverride = useSetEntitlementOverride(userId)

  const unlimitedDisabled = NEVER_UNLIMITED.includes(meter)

  async function confirm() {
    if (!reason.trim()) return
    if (!unlimited) {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 0) return
    }
    try {
      await setOverride.mutateAsync({
        meter,
        value: unlimited ? null : Number(value),
        reason: reason.trim(),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      })
      toast.success(t("toastOverrideSet"))
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
          <DialogTitle>{t("setOverrideTitle")}</DialogTitle>
          <DialogDescription>{t("setOverrideDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="space-y-1">
            <Label htmlFor="override-meter">{t("setOverrideMeterLabel")}</Label>
            <Select
              value={meter}
              onValueChange={(value) => {
                setMeter(value as UsageMeter)
                if (NEVER_UNLIMITED.includes(value as UsageMeter)) {
                  setUnlimited(false)
                }
              }}
            >
              <SelectTrigger id="override-meter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_METERS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {meterLabel(m, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="override-value">{t("setOverrideValueLabel")}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="override-value"
                type="number"
                min={0}
                value={value}
                disabled={unlimited}
                onChange={(e) => setValue(e.target.value)}
                className="w-28"
              />
              <label className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={unlimited}
                  disabled={unlimitedDisabled}
                  onCheckedChange={(checked) => setUnlimited(checked === true)}
                />
                {t("setOverrideUnlimitedLabel")}
              </label>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="override-reason">
              {t("setOverrideReasonLabel")}
            </Label>
            <Textarea
              id="override-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("setOverrideReasonPlaceholder")}
              maxLength={500}
              rows={3}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="override-expires">
              {t("setOverrideExpiresLabel")}
            </Label>
            <Input
              id="override-expires"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
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
              setOverride.isPending ||
              reason.trim() === "" ||
              (!unlimited && (value === "" || Number(value) < 0))
            }
          >
            {t("setOverrideSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SubscriptionHistory({ subscriptionId }: { subscriptionId: string }) {
  const { t } = useTranslation("subscriptions")
  const locale = useLocale()
  const { data, isPending, isError } = useSubscription(subscriptionId)
  const events = data?.events ?? []

  // ADM-035: the event history is empty only once it has loaded.
  if (isPending) {
    return <Skeleton className="h-32 w-full" />
  }
  if (isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("loadError")}
      </p>
    )
  }
  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
        <RiInformationLine
          className="mb-4 size-10 text-muted-foreground"
          aria-hidden="true"
        />
        <h3 className="mb-1 text-lg font-semibold text-balance">
          {t("historyEmptyTitle")}
        </h3>
        <p className="max-w-sm text-sm text-muted-foreground">
          {t("historyEmptyDescription")}
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("eventType")}</TableHead>
            <TableHead>{t("eventFrom")}</TableHead>
            <TableHead>{t("eventTo")}</TableHead>
            <TableHead>{t("eventAdmin")}</TableHead>
            <TableHead>{t("eventReason")}</TableHead>
            <TableHead>{t("eventCreatedAt")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => (
            <TableRow key={event.id}>
              <TableCell>
                <Badge variant="secondary">
                  {eventTypeLabel(event.type, t)}
                </Badge>
              </TableCell>
              <TableCell>
                {event.fromPlanVersion
                  ? `v${event.fromPlanVersion.version}`
                  : "—"}
              </TableCell>
              <TableCell>
                {event.toPlanVersion ? `v${event.toPlanVersion.version}` : "—"}
              </TableCell>
              <TableCell>
                {event.admin?.name ?? event.admin?.email ?? "—"}
              </TableCell>
              <TableCell
                className="max-w-48 truncate"
                title={event.reason ?? ""}
              >
                {event.reason ?? "—"}
              </TableCell>
              <TableCell>{formatDateTime(locale, event.createdAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function eventTypeLabel(type: string, t: (key: string) => string): string {
  switch (type) {
    case "CREATED":
      return t("eventCreated")
    case "MIGRATED":
      return t("eventMigrated")
    case "RENEWED":
      return t("eventRenewed")
    case "CANCELED":
      return t("eventCanceled")
    case "EXPIRED":
      return t("eventExpired")
    case "REACTIVATED":
      return t("eventReactivated")
    default:
      return type
  }
}
