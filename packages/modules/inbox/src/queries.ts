import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type { InboxListResult, InboxSubmissionDetail } from "./service"
import type { InboxActionInput, InboxTabInput } from "./validators"
import type { SubmissionStatus } from "@sendcms/database"

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

/**
 * SRC-214 — pure: the status an inbox action lands on for a submission
 * currently in `current` status, mirroring `resolveStatusAction` in
 * the service (null = the action is a no-op for that status, e.g.
 * starring an archived submission — the server returns the row
 * unchanged and writes no event). Client-safe: this file must not
 * import the service (it imports `@sendcms/database`).
 */
export function optimisticStatusForAction(
  action: InboxActionInput,
  current: SubmissionStatus
): SubmissionStatus | null {
  switch (action) {
    case "read":
      return current === "NEW" ? "READ" : null
    case "unread":
      return current === "READ" || current === "STARRED" ? "NEW" : null
    case "star":
      return current === "NEW" || current === "READ" ? "STARRED" : null
    case "unstar":
      return current === "STARRED" ? "READ" : null
    case "archive":
      return current === "NEW" || current === "READ" || current === "STARRED"
        ? "ARCHIVED"
        : null
    case "restore":
      return current === "ARCHIVED" || current === "SPAM" ? "READ" : null
    case "spam":
      return current === "NEW" || current === "READ" || current === "STARRED"
        ? "SPAM"
        : null
    case "not-spam":
      return current === "SPAM" ? "READ" : null
  }
}

type InboxListSnapshot = ReturnType<QueryClient["getQueriesData"]>

/** SRC-214: snapshot every cached inbox list, then apply the action's
    status to the matching rows in place. Detail entries share the
    ["inbox"] prefix but have no `items` array, so the guard skips
    them; the caller patches the open detail separately. Tab
    membership is left to the `onSettled` refetch — a row that moves
    out of the current tab (e.g. archived from "all") stays visible
    with its new status until the refetch lands. */
function snapshotAndApplyInboxStatus(
  qc: QueryClient,
  ids: Set<string>,
  action: InboxActionInput
): InboxListSnapshot {
  const previousLists = qc.getQueriesData({ queryKey: ["inbox"] })
  for (const [key, data] of previousLists) {
    const list = data as InboxListResult | undefined
    if (!list || !Array.isArray(list.items)) continue
    qc.setQueryData(key, {
      ...list,
      items: list.items.map((item) => {
        if (!ids.has(item.id)) return item
        const next = optimisticStatusForAction(action, item.status)
        return next ? { ...item, status: next } : item
      }),
    })
  }
  return previousLists
}

function restoreInboxLists(qc: QueryClient, previousLists: InboxListSnapshot) {
  for (const [key, data] of previousLists) {
    qc.setQueryData(key, data)
  }
}

export function useUpdateSubmissionStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: InboxActionInput }) =>
      apiFetch<{ id: string; status: string; changed: boolean }>(
        `/api/v1/inbox/${id}`,
        { method: "PATCH", body: JSON.stringify({ action }) }
      ),
    onMutate: async ({ id, action }) => {
      await qc.cancelQueries({ queryKey: ["inbox"] })
      const previousLists = snapshotAndApplyInboxStatus(
        qc,
        new Set([id]),
        action
      )
      const previousDetail = qc.getQueryData<InboxSubmissionDetail>(
        inboxKeys.detail(id)
      )
      if (previousDetail) {
        const next = optimisticStatusForAction(action, previousDetail.status)
        if (next) {
          qc.setQueryData(inboxKeys.detail(id), {
            ...previousDetail,
            status: next,
          })
        }
      }
      return { previousLists, previousDetail }
    },
    onError: (_err, { id }, ctx) => {
      if (!ctx) return
      restoreInboxLists(qc, ctx.previousLists)
      if (ctx.previousDetail) {
        qc.setQueryData(inboxKeys.detail(id), ctx.previousDetail)
      }
    },
    onSettled: () => invalidateInbox(qc),
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

/** Auto-reply drafts (Phase 12, Step 4). Drafts a reply with the
    model; the owner reviews and edits it before anything is sent. */
export type ReplyDraft = { subject: string; body: string }

export function useDraftReply(submissionId: string) {
  return useMutation({
    mutationFn: () =>
      apiFetch<ReplyDraft>(`/api/v1/inbox/${submissionId}/ai/draft-reply`, {
        method: "POST",
      }),
  })
}

/** Sends the owner's (reviewed and edited) reply through the outbox. */
export function useSendReply(submissionId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { subject: string; body: string }) =>
      apiFetch<{ enqueued: number }>(
        `/api/v1/inbox/${submissionId}/ai/send-reply`,
        { method: "POST", body: JSON.stringify(body) }
      ),
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
    onMutate: async ({ ids, action }) => {
      await qc.cancelQueries({ queryKey: ["inbox"] })
      // Bulk runs from the list view, so only list caches are
      // patched (an open detail, if any, is corrected by the
      // onSettled refetch).
      const previousLists = snapshotAndApplyInboxStatus(
        qc,
        new Set(ids),
        action
      )
      return { previousLists }
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return
      restoreInboxLists(qc, ctx.previousLists)
    },
    onSettled: () => invalidateInbox(qc),
  })
}
