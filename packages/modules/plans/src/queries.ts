import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type {
  EffectiveEntitlements,
  EntitlementOverrideRow,
  LimitCheck,
  MigrationPreview,
  PlanDetail,
  PlanSummary,
  PlanVersionSummary,
  SubscriptionDetail,
  SubscriptionSummary,
  UsageRow,
  VersionDiff,
} from "./service"
import type {
  AssignSubscriptionInput,
  CancelSubscriptionInput,
  CreatePlanInput,
  CreatePlanVersionInput,
  DuplicatePlanInput,
  EntitlementOverrideListQuery,
  ExecuteMigrationInput,
  MigrationPreviewInput,
  PlanListQuery,
  PublishPlanVersionInput,
  SetEntitlementOverrideInput,
  SubscriptionListQuery,
} from "./validators"

export type {
  EffectiveEntitlements,
  EntitlementOverrideRow,
  LimitCheck,
  MigrationPreview,
  PlanDetail,
  PlanSummary,
  PlanVersionSummary,
  SubscriptionDetail,
  SubscriptionSummary,
  UsageRow,
  VersionDiff,
}
export type {
  AssignSubscriptionInput,
  CancelSubscriptionInput,
  CreatePlanInput,
  CreatePlanVersionInput,
  DuplicatePlanInput,
  EntitlementOverrideListQuery,
  ExecuteMigrationInput,
  MigrationPreviewInput,
  PlanListQuery,
  PublishPlanVersionInput,
  SetEntitlementOverrideInput,
  SubscriptionListQuery,
}

export type PlansListResponse = {
  plans: PlanSummary[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export type SubscriptionsListResponse = {
  subscriptions: SubscriptionSummary[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export type OverridesListResponse = {
  overrides: EntitlementOverrideRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export type UserSubscriptionResponse =
  | (SubscriptionSummary & {
      entitlements: EffectiveEntitlements["entitlements"]
    })
  | null

export type UsageResponse = {
  userId: string
  meter: string | null
  period: string
  total: number
  liveTotal: number | null
  divergent: boolean
  orphanLedgerRows: number
}

export const planKeys = {
  list: (filters: PlanListQuery) => ["plans", filters] as const,
  detail: (id: string) => ["plans", id] as const,
  version: (id: string) => ["plans", "versions", id] as const,
  compare: (from: string, to: string) =>
    ["plans", "compare", from, to] as const,
}

export const subscriptionKeys = {
  list: (filters: SubscriptionListQuery) => ["subscriptions", filters] as const,
  detail: (id: string) => ["subscriptions", id] as const,
  user: (userId: string) => ["subscriptions", "user", userId] as const,
}

export const usageKeys = {
  summary: (userId: string, meter?: string, period?: string) =>
    ["usage", userId, meter ?? "all", period ?? "current"] as const,
}

export const overrideKeys = {
  list: (filters: EntitlementOverrideListQuery) =>
    ["entitlement-overrides", filters] as const,
}

function toQueryString(
  params: Record<string, string | number | undefined>
): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  return search.toString()
}

// ─── Plans ────────────────────────────────────────────────────────────

export function usePlans(
  filters: PlanListQuery,
  initialData?: PlansListResponse
) {
  return useQuery({
    queryKey: planKeys.list(filters),
    queryFn: () =>
      apiFetch<PlansListResponse>(
        `/api/v1/admin/plans?${toQueryString({
          q: filters.q,
          status: filters.status,
          kind: filters.kind,
          page: filters.page,
          perPage: filters.perPage,
          sort: filters.sort,
        })}`
      ),
    initialData,
  })
}

export function usePlan(planId: string, initialData?: PlanDetail) {
  return useQuery({
    queryKey: planKeys.detail(planId),
    queryFn: () => apiFetch<PlanDetail>(`/api/v1/admin/plans/${planId}`),
    initialData,
    // Never fire for an empty id (e.g. before a plan is picked in a
    // wizard) — the request would hit /api/v1/admin/plans/ and 404.
    enabled: planId.trim() !== "",
  })
}

export function usePlanVersion(planId: string, versionId: string) {
  return useQuery({
    queryKey: planKeys.version(versionId),
    queryFn: () =>
      apiFetch<PlanVersionSummary>(
        `/api/v1/admin/plans/${planId}/versions/${versionId}`
      ),
  })
}

export function usePlanCompare(from: string | null, to: string | null) {
  return useQuery({
    queryKey: planKeys.compare(from ?? "", to ?? ""),
    queryFn: () =>
      apiFetch<VersionDiff>(
        `/api/v1/admin/plans/compare?${toQueryString({ from: from ?? "", to: to ?? "" })}`
      ),
    enabled: Boolean(from && to),
  })
}

// ─── Subscriptions ────────────────────────────────────────────────────

export function useSubscriptions(
  filters: SubscriptionListQuery,
  initialData?: SubscriptionsListResponse
) {
  return useQuery({
    queryKey: subscriptionKeys.list(filters),
    queryFn: () =>
      apiFetch<SubscriptionsListResponse>(
        `/api/v1/admin/subscriptions?${toQueryString({
          userId: filters.userId,
          planId: filters.planId,
          status: filters.status,
          page: filters.page,
          perPage: filters.perPage,
          sort: filters.sort,
        })}`
      ),
    initialData,
  })
}

export function useSubscription(
  subscriptionId: string,
  initialData?: SubscriptionDetail
) {
  return useQuery({
    queryKey: subscriptionKeys.detail(subscriptionId),
    queryFn: () =>
      apiFetch<SubscriptionDetail>(
        `/api/v1/admin/subscriptions/${subscriptionId}`
      ),
    initialData,
  })
}

export function useUserSubscription(userId: string) {
  return useQuery({
    queryKey: subscriptionKeys.user(userId),
    queryFn: () =>
      apiFetch<UserSubscriptionResponse>(
        `/api/v1/admin/users/${userId}/subscription`
      ),
  })
}

export function useUsage(userId: string, meter?: string, period?: string) {
  return useQuery({
    queryKey: usageKeys.summary(userId, meter, period),
    queryFn: () =>
      apiFetch<UsageResponse>(
        `/api/v1/admin/usage?${toQueryString({ userId, meter, period })}`
      ),
  })
}

export function useEntitlementOverrides(
  userId: string,
  filters: Omit<EntitlementOverrideListQuery, "userId">
) {
  return useQuery({
    queryKey: overrideKeys.list({ ...filters, userId }),
    queryFn: () =>
      apiFetch<OverridesListResponse>(
        `/api/v1/admin/users/${userId}/overrides?${toQueryString({
          meter: filters.meter,
          page: filters.page,
          perPage: filters.perPage,
        })}`
      ),
  })
}

// ─── Mutations ────────────────────────────────────────────────────────
// Every mutation invalidates the plans + subscriptions lists on success,
// so the admin UI never shows stale plan/subscription data.

function usePlansMutation() {
  const qc = useQueryClient()
  return {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plans"] })
      qc.invalidateQueries({ queryKey: ["subscriptions"] })
      qc.invalidateQueries({ queryKey: ["usage"] })
    },
  }
}

export function useCreatePlan() {
  const { onSuccess } = usePlansMutation()
  return useMutation({
    mutationFn: (body: CreatePlanInput) =>
      apiFetch<PlanDetail>("/api/v1/admin/plans", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess,
  })
}

export function useCreatePlanVersion(planId: string) {
  const { onSuccess } = usePlansMutation()
  return useMutation({
    mutationFn: (body: CreatePlanVersionInput) =>
      apiFetch<PlanVersionSummary>(`/api/v1/admin/plans/${planId}/versions`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess,
  })
}

export function usePublishPlanVersion(planId: string, versionId: string) {
  const { onSuccess } = usePlansMutation()
  return useMutation({
    mutationFn: (body: PublishPlanVersionInput) =>
      apiFetch<PlanVersionSummary>(
        `/api/v1/admin/plans/${planId}/versions/${versionId}/publish`,
        { method: "POST", body: JSON.stringify(body) }
      ),
    onSuccess,
  })
}

export function useArchivePlan(planId: string) {
  const { onSuccess } = usePlansMutation()
  return useMutation({
    mutationFn: (body: { reason?: string }) =>
      apiFetch<PlanSummary>(`/api/v1/admin/plans/${planId}/archive`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess,
  })
}

export function useDuplicatePlan(planId: string) {
  const { onSuccess } = usePlansMutation()
  return useMutation({
    mutationFn: (body: DuplicatePlanInput) =>
      apiFetch<PlanDetail>(`/api/v1/admin/plans/${planId}/duplicate`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess,
  })
}

export function useAssignSubscription() {
  const { onSuccess } = usePlansMutation()
  return useMutation({
    mutationFn: (body: AssignSubscriptionInput) =>
      apiFetch<SubscriptionSummary>("/api/v1/admin/subscriptions/assign", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess,
  })
}

// The migration preview is a POST (the selection can be 1000 userIds —
// too long for a query string) but behaves like a read from the UI's
// point of view, so it is a mutation that fetches the preview.
export function useMigrationPreview() {
  return useMutation({
    mutationFn: (body: MigrationPreviewInput) =>
      apiFetch<MigrationPreview>(
        "/api/v1/admin/subscriptions/migrate/preview",
        { method: "POST", body: JSON.stringify(body) }
      ),
  })
}

export function useExecuteMigration() {
  const { onSuccess } = usePlansMutation()
  return useMutation({
    mutationFn: (body: ExecuteMigrationInput) =>
      apiFetch<{
        migratedUserIds: string[]
        skippedUserIds: string[]
        count: number
      }>("/api/v1/admin/subscriptions/migrate", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess,
  })
}

export function useCancelSubscription(subscriptionId: string) {
  const { onSuccess } = usePlansMutation()
  return useMutation({
    mutationFn: (body: CancelSubscriptionInput) =>
      apiFetch<SubscriptionSummary>(
        `/api/v1/admin/subscriptions/${subscriptionId}/cancel`,
        { method: "POST", body: JSON.stringify(body) }
      ),
    onSuccess,
  })
}

export function useSetEntitlementOverride(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SetEntitlementOverrideInput) =>
      apiFetch<EntitlementOverrideRow>(
        `/api/v1/admin/users/${userId}/overrides`,
        { method: "POST", body: JSON.stringify(body) }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["entitlement-overrides"] })
      qc.invalidateQueries({
        queryKey: subscriptionKeys.user(userId),
      })
    },
  })
}

export function useRemoveEntitlementOverride(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (meter: string) =>
      apiFetch<{ deleted: boolean }>(
        `/api/v1/admin/users/${userId}/overrides/${meter}`,
        { method: "DELETE" }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["entitlement-overrides"] })
      qc.invalidateQueries({
        queryKey: subscriptionKeys.user(userId),
      })
    },
  })
}
