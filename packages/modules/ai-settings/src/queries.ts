"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type {
  AiKeyTestResult,
  AiProviderConfigRow,
  AiProviderHealth,
  AiUsageRow,
  AiUsageSummary,
  UserAiKeyMeta,
} from "./service"
import type { AiBillingMode } from "@sendcms/database"
import type { AiProviderName } from "@sendcms/ai"
import type { SaveAiKeyInput } from "./validators"

// React Query hooks for the dashboard customer page (/dashboard/ai)
// and the admin pages (/admin/ai/*). The API base is the same
// @sendcms/shared apiFetch the other modules use; the api app is
// reached through the dashboard's /api/v1/* rewrite proxy (or
// directly on the admin app). Keys are the invalidation unit.

export const AI_SETTINGS_KEYS = {
  keys: ["ai-keys"] as const,
  key: (provider: AiProviderName) => ["ai-keys", provider] as const,
  billingMode: ["ai-billing-mode"] as const,
  providerConfigs: ["ai-provider-configs"] as const,
  providerHealth: ["ai-provider-health"] as const,
  usage: (filters: Record<string, string | number | undefined>) =>
    ["ai-usage", filters] as const,
  usageSummary: (filters: Record<string, string | number | undefined>) =>
    ["ai-usage-summary", filters] as const,
  userKeys: (userId: string) => ["ai-user-keys", userId] as const,
  userBillingMode: (userId: string) =>
    ["ai-user-billing-mode", userId] as const,
}

// ─── Customer (dashboard) ─────────────────────────────────────────────

export function useAiKeys() {
  return useQuery({
    queryKey: AI_SETTINGS_KEYS.keys,
    queryFn: () =>
      apiFetch<{ keys: UserAiKeyMeta[] }>("/api/v1/ai/keys").then(
        (r) => r.keys
      ),
  })
}

export function useAiBillingMode() {
  return useQuery({
    queryKey: AI_SETTINGS_KEYS.billingMode,
    queryFn: () =>
      apiFetch<{ billingMode: AiBillingMode }>("/api/v1/ai/billing-mode").then(
        (r) => r.billingMode
      ),
  })
}

export function useSaveAiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SaveAiKeyInput) =>
      apiFetch<{ key: UserAiKeyMeta }>("/api/v1/ai/keys", {
        method: "POST",
        body: JSON.stringify(input),
      }).then((r) => r.key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AI_SETTINGS_KEYS.keys })
    },
  })
}

export function useTestAiKey() {
  return useMutation({
    mutationFn: (provider: AiProviderName) =>
      apiFetch<AiKeyTestResult>(`/api/v1/ai/keys/${provider}/test`, {
        method: "POST",
      }),
  })
}

// Tests a browser-only key: the raw key is sent in the body for this
// one live call and is never stored. The caller holds the key in
// localStorage; this hook never keeps it.
export function useTestBrowserAiKey() {
  return useMutation({
    mutationFn: ({
      provider,
      apiKey,
      model,
    }: {
      provider: AiProviderName
      apiKey: string
      model?: string
    }) =>
      apiFetch<AiKeyTestResult>(`/api/v1/ai/keys/${provider}/test-browser`, {
        method: "POST",
        body: JSON.stringify({ apiKey, model }),
      }),
  })
}

export function useSetAiKeyEnabled() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      provider,
      enabled,
    }: {
      provider: AiProviderName
      enabled: boolean
    }) =>
      apiFetch<{ key: UserAiKeyMeta }>(
        `/api/v1/ai/keys/${provider}/${enabled ? "enable" : "disable"}`,
        { method: "POST" }
      ).then((r) => r.key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AI_SETTINGS_KEYS.keys })
    },
  })
}

export function useDeleteAiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (provider: AiProviderName) =>
      apiFetch(`/api/v1/ai/keys/${provider}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AI_SETTINGS_KEYS.keys })
    },
  })
}

export function useSetAiBillingMode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (mode: AiBillingMode) =>
      apiFetch<{ billingMode: AiBillingMode }>("/api/v1/ai/billing-mode", {
        method: "POST",
        body: JSON.stringify({ billingMode: mode }),
      }).then((r) => r.billingMode),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: AI_SETTINGS_KEYS.billingMode,
      })
    },
  })
}

// ─── Admin ────────────────────────────────────────────────────────────

export function useProviderConfigs() {
  return useQuery({
    queryKey: AI_SETTINGS_KEYS.providerConfigs,
    queryFn: () =>
      apiFetch<{ providers: AiProviderConfigRow[] }>(
        "/api/v1/admin/ai/providers"
      ).then((r) => r.providers),
  })
}

export function useProviderHealth() {
  return useQuery({
    queryKey: AI_SETTINGS_KEYS.providerHealth,
    queryFn: () =>
      apiFetch<{ providers: AiProviderHealth[] }>(
        "/api/v1/admin/ai/providers/health"
      ).then((r) => r.providers),
  })
}

export function useSetProviderConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      provider,
      input,
    }: {
      provider: AiProviderName
      input: {
        isEnabled?: boolean
        allowedModels?: string[]
        defaultModel?: string | null
      }
    }) =>
      apiFetch<{ provider: AiProviderConfigRow }>(
        `/api/v1/admin/ai/providers/${provider}`,
        { method: "PATCH", body: JSON.stringify(input) }
      ).then((r) => r.provider),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: AI_SETTINGS_KEYS.providerConfigs,
      })
      queryClient.invalidateQueries({
        queryKey: AI_SETTINGS_KEYS.providerHealth,
      })
    },
  })
}

export function useAiUsage(filters: {
  userId?: string
  provider?: AiProviderName
  billingMode?: AiBillingMode
  from?: string
  to?: string
  page?: number
  perPage?: number
}) {
  return useQuery({
    queryKey: AI_SETTINGS_KEYS.usage(filters),
    queryFn: () => {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined) params.set(key, String(value))
      }
      const query = params.toString()
      return apiFetch<{
        usage: AiUsageRow[]
        total: number
        page: number
        perPage: number
        totalPages: number
      }>(`/api/v1/admin/ai/usage${query ? `?${query}` : ""}`)
    },
  })
}

export function useAiUsageSummary(filters: {
  userId?: string
  provider?: AiProviderName
  billingMode?: AiBillingMode
  from?: string
  to?: string
}) {
  return useQuery({
    queryKey: AI_SETTINGS_KEYS.usageSummary(filters),
    queryFn: () => {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined) params.set(key, String(value))
      }
      const query = params.toString()
      return apiFetch<AiUsageSummary>(
        `/api/v1/admin/ai/usage/summary${query ? `?${query}` : ""}`
      )
    },
  })
}

export function useUserAiKeys(userId: string) {
  return useQuery({
    queryKey: AI_SETTINGS_KEYS.userKeys(userId),
    queryFn: () =>
      apiFetch<{ keys: UserAiKeyMeta[] }>(
        `/api/v1/admin/ai/users/${userId}/keys`
      ).then((r) => r.keys),
    enabled: Boolean(userId),
  })
}

export function useSetUserAiBillingMode(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (mode: AiBillingMode) =>
      apiFetch<{ billingMode: AiBillingMode }>(
        `/api/v1/admin/ai/users/${userId}/billing-mode`,
        { method: "POST", body: JSON.stringify({ billingMode: mode }) }
      ).then((r) => r.billingMode),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: AI_SETTINGS_KEYS.userBillingMode(userId),
      })
    },
  })
}
