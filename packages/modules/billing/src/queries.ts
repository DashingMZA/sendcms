import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type { BillingProvider } from "@sendcms/database"
import type {
  MyUsageSummary,
  PublicPlan,
  SubscriptionSummary,
} from "@sendcms/plans"
import type { CancelSubscriptionInput } from "@sendcms/plans/validators"
import type {
  BillingEventRow,
  BillingProviderConfigRow,
  EnabledBillingProvider,
} from "./service"
import type { CheckoutSessionInput, SetProviderConfigInput } from "./validators"

// React Query hooks for the admin billing pages and the dashboard
// checkout page. Same pattern as @sendcms/mcp-admin/queries: the
// hook key names the resource, the fetcher hits the API (proxied to
// the api app), and errors surface as ApiClientError objects with
// status. Never fetch raw in a component.
//
// SRC-214: the fetcher is the shared `@sendcms/shared` apiFetch —
// the local raw-`fetch` copy used to throw a plain Error without
// status, so callers could not tell a 401 from a 500.

export function useBillingProviders() {
  return useQuery<BillingProviderConfigRow[]>({
    queryKey: ["billing", "providers"],
    queryFn: () =>
      apiFetch<BillingProviderConfigRow[]>("/api/v1/admin/billing/providers"),
  })
}

export function useBillingCountries() {
  return useQuery<{ code: string; name: string }[]>({
    queryKey: ["billing", "countries"],
    queryFn: () =>
      apiFetch<{ code: string; name: string }[]>(
        "/api/v1/admin/billing/countries"
      ),
  })
}

// ADM-123 / BIL-123 / BIL-092: the admin billing-events (webhook
// receipts + payment events) list. Filters mirror the API query
// schema; `processed` true = applied only, false = unprocessed only.
export type BillingEventsFilters = {
  provider?: BillingProvider
  eventType?: string
  processed?: boolean
  from?: string
  to?: string
  page?: number
  perPage?: number
}

export type BillingEventsPage = {
  events: BillingEventRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export function useBillingEvents(filters: BillingEventsFilters) {
  const params = new URLSearchParams()
  if (filters.provider) params.set("provider", filters.provider)
  if (filters.eventType) params.set("eventType", filters.eventType)
  if (filters.processed !== undefined)
    params.set("processed", String(filters.processed))
  if (filters.from) params.set("from", filters.from)
  if (filters.to) params.set("to", filters.to)
  params.set("page", String(filters.page ?? 1))
  params.set("perPage", String(filters.perPage ?? 20))
  const query = params.toString()
  return useQuery<BillingEventsPage>({
    queryKey: ["billing", "events", filters],
    queryFn: () =>
      apiFetch<BillingEventsPage>(`/api/v1/admin/billing/events?${query}`),
  })
}

export function useSetBillingProviderConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      provider,
      input,
    }: {
      provider: BillingProvider
      input: SetProviderConfigInput
    }) =>
      apiFetch<BillingProviderConfigRow>(
        `/api/v1/admin/billing/providers/${provider}`,
        { method: "PATCH", body: JSON.stringify(input) }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["billing", "providers"] })
    },
  })
}

export function useEnabledBillingProviders(
  countryCode?: string | null,
  opts?: { enabled?: boolean }
) {
  return useQuery<EnabledBillingProvider[]>({
    queryKey: ["billing", "enabled-providers", countryCode ?? "all"],
    queryFn: () =>
      apiFetch<EnabledBillingProvider[]>(
        `/api/v1/billing/providers${countryCode ? `?country=${countryCode}` : ""}`
      ),
    enabled: opts?.enabled ?? true,
  })
}

// ─── Customer checkout (dashboard) ────────────────────────────────────

export type { SubscriptionSummary } from "@sendcms/plans"

export function useMySubscription(initialData?: SubscriptionSummary | null) {
  return useQuery<SubscriptionSummary | null>({
    queryKey: ["billing", "my-subscription"],
    queryFn: () =>
      apiFetch<SubscriptionSummary | null>("/api/v1/billing/subscription"),
    initialData,
  })
}

// BIL-120 (Wave 6): take the Free plan — POST /api/v1/billing/subscription
// with the free version id. On success the subscription + usage queries
// refetch so the billing page shows the new plan at once.
export function useSubscribeFreePlan() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { planVersionId: string }) =>
      apiFetch<SubscriptionSummary>("/api/v1/billing/subscription", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["billing", "my-subscription"],
      })
      queryClient.invalidateQueries({ queryKey: ["billing", "usage"] })
    },
  })
}

// BIL-122 / BIL-091 (Wave 6): cancel the caller's own subscription.
// Local-only until Wave 8 wires the provider cancel (BIL-001/BIL-082)
// — see cancelMySubscription in @sendcms/plans.
export function useCancelMySubscription() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CancelSubscriptionInput) =>
      apiFetch<SubscriptionSummary>("/api/v1/billing/subscription/cancel", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["billing", "my-subscription"],
      })
      queryClient.invalidateQueries({ queryKey: ["billing", "usage"] })
    },
  })
}

// BIL-124 (Wave 6): the caller's own plan, limits, and remaining quota
// per meter — the billing page's limits/usage section.
export function useMyUsage() {
  return useQuery<MyUsageSummary>({
    queryKey: ["billing", "usage"],
    queryFn: () => apiFetch<MyUsageSummary>("/api/v1/billing/usage"),
  })
}

// BIL-092 completion (Wave 6): the caller's own payment history —
// webhook/billing events attributed to them. Same filters as the
// admin list; the server scopes every query to the caller.
export function useMyBillingEvents(filters: BillingEventsFilters) {
  const params = new URLSearchParams()
  if (filters.provider) params.set("provider", filters.provider)
  if (filters.eventType) params.set("eventType", filters.eventType)
  if (filters.processed !== undefined)
    params.set("processed", String(filters.processed))
  if (filters.from) params.set("from", filters.from)
  if (filters.to) params.set("to", filters.to)
  params.set("page", String(filters.page ?? 1))
  params.set("perPage", String(filters.perPage ?? 20))
  const query = params.toString()
  return useQuery<BillingEventsPage>({
    queryKey: ["billing", "my-events", filters],
    queryFn: () =>
      apiFetch<BillingEventsPage>(`/api/v1/billing/events?${query}`),
  })
}

export function usePublishedPlans() {
  return useQuery<PublicPlan[]>({
    queryKey: ["billing", "published-plans"],
    queryFn: () => apiFetch<PublicPlan[]>("/api/public/v1/plans"),
  })
}

export function usePublicCountries() {
  return useQuery<{ code: string; name: string }[]>({
    queryKey: ["billing", "public-countries"],
    queryFn: () =>
      apiFetch<{ code: string; name: string }[]>(
        "/api/public/v1/billing/countries"
      ),
  })
}

export function useCreateCheckoutSession() {
  return useMutation({
    mutationFn: (input: CheckoutSessionInput) =>
      apiFetch<{ checkoutUrl: string; provider: BillingProvider }>(
        "/api/v1/billing/checkout",
        { method: "POST", body: JSON.stringify(input) }
      ),
  })
}

export type { BillingProvider }
