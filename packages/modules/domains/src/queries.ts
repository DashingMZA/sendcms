import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type {
  DomainDetail,
  DomainListResult,
  DomainWithVerification,
} from "./service"
import type { DomainListQueryInput } from "./validators"
import type {
  DomainStatus,
  DomainVerification,
  DomainVerificationMethod,
} from "@sendcms/database"

export type { DomainDetail, DomainListResult, DomainWithVerification }

export type { DomainListQueryInput }

export type VerifyResult = {
  verified: boolean
  domain: DomainDetail
  attempts: number
  maxAttempts: number
  reason?: string
}

export const domainKeys = {
  list: ["domains"] as const,
  page: (params: DomainListQueryInput) => ["domains", "page", params] as const,
  detail: (id: string) => ["domains", id] as const,
}

export function useDomains(initialData?: DomainWithVerification[]) {
  return useQuery({
    queryKey: domainKeys.list,
    queryFn: () => apiFetch<DomainWithVerification[]>("/api/v1/domains"),
    initialData,
  })
}

// DSH-107: the paged list the dashboard tables use — search, sort and
// pagination ride in the URL (the page passes its parsed params in),
// so the table refetches when the user pages or searches. The key
// nests under domainKeys.list, so the create/verify/delete mutations'
// invalidateQueries({ queryKey: domainKeys.list }) refreshes paged
// lists too.
export function useDomainsPage(
  params: DomainListQueryInput,
  initialData?: DomainListResult
) {
  return useQuery({
    queryKey: domainKeys.page(params),
    queryFn: () =>
      apiFetch<DomainListResult>(`/api/v1/domains${toQueryString(params)}`),
    initialData,
  })
}

function toQueryString(params: DomainListQueryInput): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      query.set(key, String(value))
    }
  }
  const text = query.toString()
  return text ? `?${text}` : ""
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

/**
 * SRC-214 — pure: the status a suspend/reactivate lands on, mirroring
 * `setDomainStatusForUser` in the service (reactivate restores
 * VERIFIED when the domain was verified, else PENDING). Client-safe:
 * this file must not import the service (it imports `@sendcms/database`).
 */
export function optimisticDomainStatus(
  action: "suspend" | "reactivate",
  verifiedAt: Date | string | null
): DomainStatus {
  if (action === "suspend") return "SUSPENDED"
  return verifiedAt ? "VERIFIED" : "PENDING"
}

export function useSetDomainStatus(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { action: "suspend" | "reactivate" }) =>
      apiFetch<DomainDetail>(`/api/v1/domains/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: domainKeys.detail(id) })
      await qc.cancelQueries({ queryKey: domainKeys.list })
      const previousDetail = qc.getQueryData<DomainDetail>(
        domainKeys.detail(id)
      )
      const previousLists = qc.getQueriesData({
        queryKey: domainKeys.list,
      })
      const status = optimisticDomainStatus(
        body.action,
        previousDetail?.verifiedAt ?? null
      )
      if (previousDetail) {
        qc.setQueryData<DomainDetail>(domainKeys.detail(id), {
          ...previousDetail,
          status,
        })
      }
      // Every cached list under ["domains"] (the plain list and the
      // paged lists) gets the same status applied to the row; the
      // detail entry itself is skipped here — it was patched above.
      for (const [key, data] of previousLists) {
        if (key[1] === id) continue
        if (Array.isArray(data)) {
          qc.setQueryData(
            key,
            data.map((row: DomainWithVerification) =>
              row.id === id ? { ...row, status } : row
            )
          )
        } else if (
          data &&
          typeof data === "object" &&
          "items" in data &&
          Array.isArray((data as DomainListResult).items)
        ) {
          qc.setQueryData(key, {
            ...(data as DomainListResult),
            items: (data as DomainListResult).items.map((row) =>
              row.id === id ? { ...row, status } : row
            ),
          })
        }
      }
      return { previousDetail, previousLists }
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return
      if (ctx.previousDetail) {
        qc.setQueryData(domainKeys.detail(id), ctx.previousDetail)
      }
      for (const [key, data] of ctx.previousLists) {
        qc.setQueryData(key, data)
      }
    },
    onSuccess: (updated) => {
      qc.setQueryData(domainKeys.detail(id), updated)
      qc.invalidateQueries({ queryKey: domainKeys.list })
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: domainKeys.detail(id) })
    },
  })
}

export function useDeleteDomain(id: string) {
  const qc = useQueryClient()
  return useMutation({
    // SRC-208: the domain string travels as the confirmation token —
    // the service deletes only when it matches.
    mutationFn: (confirmation: string) =>
      apiFetch<void>(`/api/v1/domains/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmation }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: domainKeys.list })
    },
  })
}
