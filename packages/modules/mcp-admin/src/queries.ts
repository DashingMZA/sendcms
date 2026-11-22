"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type {
  McpKeyRow,
  McpSettingsRow,
  McpUsageRow,
  McpUsageSummary,
  UserMcpSettingsRow,
} from "./service"
import type {
  RevokeMcpKeyInput,
  SetMcpSettingsInput,
  SetUserMcpSettingsInput,
} from "./validators"

// React Query hooks for the admin pages (/admin/mcp/*). The API base
// is the same @sendcms/shared apiFetch the other modules use; the api
// app is reached through the admin app's /api/v1/* rewrite proxy (or
// directly). Keys are the invalidation unit.

export const MCP_ADMIN_KEYS = {
  settings: ["mcp-settings"] as const,
  userSettings: (userId: string) => ["mcp-user-settings", userId] as const,
  usage: (filters: Record<string, string | number | undefined>) =>
    ["mcp-usage", filters] as const,
  usageSummary: (filters: Record<string, string | number | undefined>) =>
    ["mcp-usage-summary", filters] as const,
  keys: (page: number, perPage: number) => ["mcp-keys", page, perPage] as const,
}

// ─── Global kill-switch ───────────────────────────────────────────────

export function useMcpSettings() {
  return useQuery({
    queryKey: MCP_ADMIN_KEYS.settings,
    queryFn: () => apiFetch<McpSettingsRow>("/api/v1/admin/mcp/settings"),
  })
}

export function useSetMcpSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SetMcpSettingsInput) =>
      apiFetch<McpSettingsRow>("/api/v1/admin/mcp/settings", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MCP_ADMIN_KEYS.settings })
    },
  })
}

// ─── Per-user controls ────────────────────────────────────────────────

export function useUserMcpSettings(userId: string) {
  return useQuery({
    queryKey: MCP_ADMIN_KEYS.userSettings(userId),
    queryFn: () =>
      apiFetch<UserMcpSettingsRow>(
        `/api/v1/admin/mcp/users/${userId}/settings`
      ),
    enabled: Boolean(userId),
  })
}

export function useSetUserMcpSettings(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SetUserMcpSettingsInput) =>
      apiFetch<UserMcpSettingsRow>(
        `/api/v1/admin/mcp/users/${userId}/settings`,
        { method: "POST", body: JSON.stringify(input) }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: MCP_ADMIN_KEYS.userSettings(userId),
      })
    },
  })
}

// ─── Usage reporting ──────────────────────────────────────────────────

export function useMcpUsage(filters: {
  userId?: string
  apiKeyId?: string
  tool?: string
  status?: "SUCCESS" | "FAILED"
  from?: string
  to?: string
  page?: number
  perPage?: number
}) {
  return useQuery({
    queryKey: MCP_ADMIN_KEYS.usage(filters),
    queryFn: () => {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined) params.set(key, String(value))
      }
      const query = params.toString()
      return apiFetch<{
        usage: McpUsageRow[]
        total: number
        page: number
        perPage: number
        totalPages: number
      }>(`/api/v1/admin/mcp/usage${query ? `?${query}` : ""}`)
    },
  })
}

export function useMcpUsageSummary(filters: {
  userId?: string
  from?: string
  to?: string
}) {
  return useQuery({
    queryKey: MCP_ADMIN_KEYS.usageSummary(filters),
    queryFn: () => {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined) params.set(key, String(value))
      }
      const query = params.toString()
      return apiFetch<McpUsageSummary>(
        `/api/v1/admin/mcp/usage/summary${query ? `?${query}` : ""}`
      )
    },
  })
}

// ─── Keys ─────────────────────────────────────────────────────────────

export function useMcpKeys(page = 1, perPage = 20) {
  return useQuery({
    queryKey: MCP_ADMIN_KEYS.keys(page, perPage),
    queryFn: () =>
      apiFetch<{
        keys: McpKeyRow[]
        total: number
        page: number
        perPage: number
        totalPages: number
      }>(`/api/v1/admin/mcp/keys?page=${page}&perPage=${perPage}`),
  })
}

export function useRevokeMcpKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      keyId,
      input,
    }: {
      keyId: string
      input: RevokeMcpKeyInput
    }) =>
      apiFetch<{ revoked: boolean; keyId: string }>(
        `/api/v1/admin/mcp/keys/${keyId}/revoke`,
        { method: "POST", body: JSON.stringify(input) }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-keys"] })
    },
  })
}
