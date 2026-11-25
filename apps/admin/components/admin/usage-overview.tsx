"use client"

import { useRef, useState } from "react"
import { Search } from "lucide-react"
import { useAdminUsers } from "@sendcms/admin-users/queries"
import {
  useEntitlementOverrides,
  usePlans,
  usePlanVersion,
  useUsage,
  useUserSubscription,
} from "@sendcms/plans/queries"
import type { PlanEntitlements, UsageMeter } from "@sendcms/plans/validators"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
} from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"

const DEBOUNCE_MS = 300

const ALL_METERS: UsageMeter[] = [
  "FORMS",
  "DOMAINS",
  "SUBMISSIONS",
  "API_KEYS",
  "MCP_REQUESTS",
  "AI_REQUESTS",
]

/** ISO date (YYYY-MM-DD) of the first day of the current UTC month. */
function monthStartIso(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`
}

/** ISO date (YYYY-MM-DD) of today (UTC). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/** The ledger bucket start (as a date) each meter's usage is summed over. */
function periodForMeter(meter: UsageMeter): string {
  return meter === "AI_REQUESTS" ? todayIso() : monthStartIso()
}

function periodLabelKey(meter: UsageMeter): string {
  if (meter === "AI_REQUESTS") return "periodToday"
  return "periodThisMonth"
}

type SelectedUser = { id: string; name: string | null; email: string }

export function UsageOverview() {
  const { t } = useTranslation("usage")
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [selectedUser, setSelectedUser] = useState<SelectedUser | null>(null)
  const [meterFilter, setMeterFilter] = useState<string>("all")

  const { data: usersData } = useAdminUsers({
    q: debouncedSearch || undefined,
    page: 1,
    perPage: 10,
    sort: "createdAt:desc",
  })
  const users = usersData?.users ?? []

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function handleSearchChange(value: string) {
    setSearch(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(
      () => setDebouncedSearch(value.trim()),
      DEBOUNCE_MS
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("selectUserTitle")}</CardTitle>
          <CardDescription>{t("searchHint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="relative max-w-md">
            <Search className="absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t("searchPlaceholder")}
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="ps-9"
            />
          </div>
          {users.length > 0 && (
            <div className="max-w-md rounded-lg border">
              {users.map((user) => {
                const selected = selectedUser?.id === user.id
                return (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => setSelectedUser(user)}
                    className={`flex w-full items-center justify-between px-3 py-2 text-start hover:bg-accent ${selected ? "bg-accent" : ""}`}
                  >
                    <span>
                      <span className="block text-sm font-medium">
                        {user.name ?? "—"}
                      </span>
                      <span className="block text-sm text-muted-foreground">
                        {user.email}
                      </span>
                    </span>
                    {selected && <Badge variant="secondary">✓</Badge>}
                  </button>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {!selectedUser ? (
        <Card>
          <CardContent className="py-10 text-center">
            <h3 className="mb-1 text-lg font-semibold">{t("noUserTitle")}</h3>
            <p className="text-sm text-muted-foreground">
              {t("noUserDescription")}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{selectedUser.name ?? selectedUser.email}</CardTitle>
            <CardDescription>{selectedUser.email}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="usage-meter-filter">
                  {t("meterFilterLabel")}
                </Label>
                <Select value={meterFilter} onValueChange={setMeterFilter}>
                  <SelectTrigger id="usage-meter-filter" className="h-9 w-52">
                    <SelectValue placeholder={t("meterAll")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("meterAll")}</SelectItem>
                    {ALL_METERS.map((meter) => (
                      <SelectItem key={meter} value={meter}>
                        {meterLabel(meter, t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <UsageTable userId={selectedUser.id} meterFilter={meterFilter} />
            <p className="text-xs text-muted-foreground">{t("usageNote")}</p>
          </CardContent>
        </Card>
      )}
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

/**
 * Resolves the limit source for a user: their subscription's effective
 * plan version entitlements when subscribed, else the default Free
 * plan's published version entitlements. Overrides (fetched here) win
 * per meter. The free-plan lookup only mounts when the user has no
 * subscription, so no request fires for subscribed users.
 *
 * ADM-035: while the subscription / plans fetch is pending the table
 * shows a skeleton, and on failure an error state — never a false
 * zero or a false "no limit". ADM-038: the Free plan is resolved by
 * exact slug (`?slug=free`) instead of paging the plan list, so it
 * keeps resolving past 100 plans; the "No limit set" fallback below
 * only applies when no Free plan exists at all.
 */
function UsageTable({
  userId,
  meterFilter,
}: {
  userId: string
  meterFilter: string
}) {
  const { t } = useTranslation("usage")
  const {
    data: subscription,
    isPending: subscriptionPending,
    isError: subscriptionError,
    refetch: refetchSubscription,
  } = useUserSubscription(userId)
  const {
    data: plansData,
    isPending: plansPending,
    isError: plansError,
    refetch: refetchPlans,
  } = usePlans({
    slug: "free",
    page: 1,
    perPage: 1,
    sort: "createdAt:desc",
  })
  const { data: overridesData } = useEntitlementOverrides(userId, {
    page: 1,
    perPage: 20,
  })

  if (subscriptionPending || plansPending) {
    return <Skeleton className="h-64 w-full" />
  }
  if (subscriptionError || plansError) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm"
      >
        <span>{t("loadError")}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void refetchSubscription()
            void refetchPlans()
          }}
        >
          {t("retry")}
        </Button>
      </div>
    )
  }

  // Exact-slug lookup: the list holds the Free plan (if one exists).
  const freePlan = plansData?.plans[0] ?? null

  if (subscription) {
    return (
      <MeterRows
        userId={userId}
        entitlements={subscription.entitlements}
        overrides={overridesData?.overrides ?? []}
        meterFilter={meterFilter}
      />
    )
  }
  if (freePlan?.currentVersion) {
    return (
      <FreePlanRows
        userId={userId}
        planId={freePlan.id}
        versionId={freePlan.currentVersion.id}
        overrides={overridesData?.overrides ?? []}
        meterFilter={meterFilter}
      />
    )
  }
  return (
    <MeterRows
      userId={userId}
      entitlements={null}
      overrides={overridesData?.overrides ?? []}
      meterFilter={meterFilter}
    />
  )
}

function FreePlanRows({
  userId,
  planId,
  versionId,
  overrides,
  meterFilter,
}: {
  userId: string
  planId: string
  versionId: string
  overrides: { meter: UsageMeter; value: number | null }[]
  meterFilter: string
}) {
  const { t } = useTranslation("usage")
  const {
    data: version,
    isPending,
    isError,
    refetch,
  } = usePlanVersion(planId, versionId)
  // ADM-035: a failed version fetch must not fall through to the
  // null-entitlements "No limit set" rows.
  if (isPending) {
    return <Skeleton className="h-64 w-full" />
  }
  if (isError) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm"
      >
        <span>{t("loadError")}</span>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          {t("retry")}
        </Button>
      </div>
    )
  }
  return (
    <MeterRows
      userId={userId}
      entitlements={version?.entitlements ?? null}
      overrides={overrides}
      meterFilter={meterFilter}
    />
  )
}

const METER_LIMIT_KEY = {
  FORMS: "forms",
  DOMAINS: "domains",
  SUBMISSIONS: "submissionsPerMonth",
  API_KEYS: "apiKeys",
  MCP_REQUESTS: "mcpRequestsPerHour",
  AI_REQUESTS: "aiRequestsPerDay",
} as const

function MeterRows({
  userId,
  entitlements,
  overrides,
  meterFilter,
}: {
  userId: string
  entitlements: PlanEntitlements | null
  overrides: { meter: UsageMeter; value: number | null }[]
  meterFilter: string
}) {
  const { t } = useTranslation("usage")
  const meters =
    meterFilter === "all"
      ? ALL_METERS
      : (ALL_METERS.filter((m) => m === meterFilter) as UsageMeter[])

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("colMeter")}</TableHead>
            <TableHead>{t("colUsed")}</TableHead>
            <TableHead>{t("colLimit")}</TableHead>
            <TableHead>{t("colRemaining")}</TableHead>
            <TableHead>{t("colPeriod")}</TableHead>
            <TableHead>{t("colSource")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {meters.map((meter) => {
            const override = overrides.find((o) => o.meter === meter)
            const limit =
              override !== undefined
                ? override.value
                : entitlements
                  ? entitlements[METER_LIMIT_KEY[meter]]
                  : null
            const hasLimitSource =
              override !== undefined || entitlements !== null
            const source =
              override !== undefined
                ? "override"
                : hasLimitSource
                  ? "plan"
                  : "none"
            // MCP_REQUESTS buckets hourly and the usage endpoint only
            // accepts a date, so its row never calls the endpoint — it
            // renders the limit with no used value (see the footnote).
            if (meter === "MCP_REQUESTS") {
              return (
                <McpMeterRow
                  key={meter}
                  meter={meter}
                  limit={limit}
                  source={source}
                  isOverride={override !== undefined}
                />
              )
            }
            return (
              <UsageMeterRow
                key={meter}
                userId={userId}
                meter={meter}
                limit={limit}
                source={source}
                isOverride={override !== undefined}
              />
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * One meter row. Usage comes from the usage endpoint (ledger totals
 * for the meter's bucket).
 */
function UsageMeterRow({
  userId,
  meter,
  limit,
  source,
  isOverride,
}: {
  userId: string
  meter: UsageMeter
  limit: number | null
  source: "override" | "plan" | "none"
  isOverride: boolean
}) {
  const { data, isPending, isError } = useUsage(
    userId,
    meter,
    periodForMeter(meter)
  )
  // ADM-033: show the live count enforcement uses when the endpoint
  // has one, falling back to the ledger total for past buckets.
  // ADM-035: while loading the used cell is a skeleton and on failure
  // an error note — never a false 0.
  const used =
    isPending || isError ? null : (data?.liveTotal ?? data?.total ?? 0)
  const remaining =
    isError || isPending || limit === null || used === null
      ? null
      : Math.max(0, limit - used)
  return (
    <MeterRowCells
      meter={meter}
      used={used}
      usedLoading={isPending}
      usedError={isError}
      limit={limit}
      remaining={remaining}
      periodKey={periodLabelKey(meter)}
      source={source}
      isOverride={isOverride}
      divergent={data?.divergent ?? false}
    />
  )
}

/** MCP_REQUESTS buckets hourly, and the usage endpoint only accepts a
    date — so this row shows the limit with no used value (see the page
    footnote). It is enforced live per API key instead. */
function McpMeterRow({
  meter,
  limit,
  source,
  isOverride,
}: {
  meter: UsageMeter
  limit: number | null
  source: "override" | "plan" | "none"
  isOverride: boolean
}) {
  return (
    <MeterRowCells
      meter={meter}
      used={null}
      limit={limit}
      remaining={null}
      periodKey="periodThisHour"
      source={source}
      isOverride={isOverride}
    />
  )
}

function MeterRowCells({
  meter,
  used,
  usedLoading = false,
  usedError = false,
  limit,
  remaining,
  periodKey,
  source,
  isOverride,
  divergent = false,
}: {
  meter: UsageMeter
  used: number | null
  usedLoading?: boolean
  usedError?: boolean
  limit: number | null
  remaining: number | null
  periodKey: string
  source: "override" | "plan" | "none"
  isOverride: boolean
  divergent?: boolean
}) {
  const { t } = useTranslation("usage")
  const sourceLabel =
    source === "override"
      ? t("sourceOverride")
      : source === "plan"
        ? t("sourcePlan")
        : "—"
  return (
    <TableRow>
      <TableCell className="font-medium">{meterLabel(meter, t)}</TableCell>
      <TableCell>
        <span className="flex items-center gap-2">
          {usedLoading ? (
            <Skeleton className="h-4 w-10" />
          ) : usedError ? (
            <span className="text-sm text-destructive">
              {t("usageLoadError")}
            </span>
          ) : used === null ? (
            "—"
          ) : (
            used
          )}
          {divergent && <Badge variant="outline">{t("divergentBadge")}</Badge>}
        </span>
      </TableCell>
      <TableCell>
        {limit === null
          ? source === "none"
            ? t("noLimit")
            : t("unlimited")
          : limit}
      </TableCell>
      <TableCell>
        {source === "none" || usedError
          ? "—"
          : remaining === null
            ? t("unlimited")
            : remaining}
      </TableCell>
      <TableCell>{t(periodKey)}</TableCell>
      <TableCell>
        <span className="flex items-center gap-2">
          {sourceLabel}
          {isOverride && (
            <Badge variant="secondary">{t("overrideBadge")}</Badge>
          )}
        </span>
      </TableCell>
    </TableRow>
  )
}
