import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type { InboxListResult, InboxSubmissionDetail } from "./service"
import type { InboxActionInput, InboxTabInput } from "./validators"

export type { InboxListResult, InboxSubmissionDetail }

export type InboxListParams = {
  tab?: InboxTabInput
  formId?: string
  originDomain?: string
  search?: string
  from?: string
  to?: string
  page?: number
}

export const inboxKeys = {
  list: (params: InboxListParams) => ["inbox", params] as const,
  detail: (id: string) => ["inbox", id] as const,
}

function toQueryString(params: InboxListParams): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      query.set(key, String(value))
    }
  }
  const text = query.toString()
  return text ? `?${text}` : ""
}

export function useInbox(
  params: InboxListParams,
  initialData?: InboxListResult
) {
  return useQuery({
    queryKey: inboxKeys.list(params),
    queryFn: () =>
      apiFetch<InboxListResult>(`/api/v1/inbox${toQueryString(params)}`),
    initialData,
  })
}

export function useSubmission(id: string, initialData?: InboxSubmissionDetail) {
  return useQuery({
    queryKey: inboxKeys.detail(id),
    queryFn: () => apiFetch<InboxSubmissionDetail>(`/api/v1/inbox/${id}`),
    initialData,
  })
}

function invalidateInbox(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["inbox"] })
}

export function useUpdateSubmissionStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: InboxActionInput }) =>
      apiFetch<{ id: string; status: string; changed: boolean }>(
        `/api/v1/inbox/${id}`,
        { method: "PATCH", body: JSON.stringify({ action }) }
      ),
    onSuccess: () => invalidateInbox(qc),
  })
}

export function useDeleteSubmission() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/inbox/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateInbox(qc),
  })
}

export function useBulkUpdateSubmissions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { ids: string[]; action: InboxActionInput }) =>
      apiFetch<{ updated: number; skipped: number }>("/api/v1/inbox/bulk", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateInbox(qc),
  })
}
