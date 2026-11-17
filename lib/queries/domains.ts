import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-client"
import type {
  DomainDetail,
  DomainWithVerification,
} from "@/lib/services/domain-service"
import type {
  DomainVerification,
  DomainVerificationMethod,
} from "@/generated/prisma/client"

export type { DomainDetail, DomainWithVerification }

export type VerifyResult = {
  verified: boolean
  domain: DomainDetail
  attempts: number
  maxAttempts: number
  reason?: string
}

export const domainKeys = {
  list: ["domains"] as const,
  detail: (id: string) => ["domains", id] as const,
}

export function useDomains(initialData?: DomainWithVerification[]) {
  return useQuery({
    queryKey: domainKeys.list,
    queryFn: () => apiFetch<DomainWithVerification[]>("/api/v1/domains"),
    initialData,
  })
}

export function useDomain(id: string, initialData?: DomainDetail) {
  return useQuery({
    queryKey: domainKeys.detail(id),
    queryFn: () => apiFetch<DomainDetail>(`/api/v1/domains/${id}`),
    initialData,
  })
}

export function useCreateDomain() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { domain: string; method: DomainVerificationMethod }) =>
      apiFetch<DomainWithVerification>("/api/v1/domains", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: domainKeys.list })
    },
  })
}

export function useVerifyDomain(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<VerifyResult>(`/api/v1/domains/${id}/verify`, {
        method: "POST",
      }),
    onSuccess: (result) => {
      if (result.verified) {
        qc.invalidateQueries({ queryKey: domainKeys.list })
        qc.invalidateQueries({ queryKey: domainKeys.detail(id) })
      }
    },
  })
}

export function useReverifyDomain(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { method?: DomainVerificationMethod }) =>
      apiFetch<DomainVerification>(`/api/v1/domains/${id}/reverify`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: domainKeys.list })
      qc.invalidateQueries({ queryKey: domainKeys.detail(id) })
    },
  })
}

export function useSetDomainStatus(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { action: "suspend" | "reactivate" }) =>
      apiFetch<DomainDetail>(`/api/v1/domains/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (updated) => {
      qc.setQueryData(domainKeys.detail(id), updated)
      qc.invalidateQueries({ queryKey: domainKeys.list })
    },
  })
}

export function useDeleteDomain(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/v1/domains/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: domainKeys.list })
    },
  })
}
