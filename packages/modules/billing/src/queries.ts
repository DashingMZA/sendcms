import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { BillingProvider } from "@sendcms/database"
import type { PublicPlan, SubscriptionSummary } from "@sendcms/plans"
import type {
  BillingProviderConfigRow,
  EnabledBillingProvider,
} from "./service"
import type { CheckoutSessionInput, SetProviderConfigInput } from "./validators"

// React Query hooks for the admin billing pages and the dashboard
// checkout page. Same pattern as @sendcms/mcp-admin/queries: the
// hook key names the resource, the fetcher hits the API (proxied to
// the api app), and errors surface as Error objects. Never fetch raw
// in a component.

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string
    } | null
    throw new Error(body?.error ?? `Request failed (${res.status})`)
  }
  return (await res.json()) as T
}

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

export function useMySubscription() {
  return useQuery<SubscriptionSummary | null>({
    queryKey: ["billing", "my-subscription"],
    queryFn: () =>
      apiFetch<SubscriptionSummary | null>("/api/v1/billing/subscription"),
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
