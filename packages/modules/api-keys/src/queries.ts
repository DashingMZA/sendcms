import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type { ApiKeyPublic, ApiKeyWithPlaintext } from "./service"

export type { ApiKeyPublic, ApiKeyWithPlaintext }

export const apiKeyKeys = {
  list: ["api-keys"] as const,
}

export function useApiKeys(initialData?: ApiKeyPublic[]) {
  return useQuery({
    queryKey: apiKeyKeys.list,
    queryFn: () => apiFetch<ApiKeyPublic[]>("/api/v1/api-keys"),
    initialData,
  })
}

export function useCreateApiKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; scope: "READ" | "FULL" }) =>
      apiFetch<ApiKeyWithPlaintext>("/api/v1/api-keys", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: apiKeyKeys.list })
    },
  })
}

export function useRevokeApiKey(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/v1/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: apiKeyKeys.list })
    },
  })
}

export function useRotateApiKey(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<ApiKeyWithPlaintext>(`/api/v1/api-keys/${id}/rotate`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: apiKeyKeys.list })
    },
  })
}
