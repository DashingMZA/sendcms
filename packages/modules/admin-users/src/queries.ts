import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type {
  AdminUserDetail,
  AdminUserSubmissionMeta,
  AdminUserSummary,
} from "./service"
import type { AdminUserListQuery } from "./validators"

export type { AdminUserDetail, AdminUserSubmissionMeta, AdminUserSummary }
export type { AdminUserListQuery }

export type AdminUsersListResponse = {
  users: AdminUserSummary[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export type AdminUserSubmissionsResponse = {
  submissions: AdminUserSubmissionMeta[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export const adminUserKeys = {
  list: (filters: AdminUserListQuery) => ["admin-users", filters] as const,
  detail: (id: string) => ["admin-users", id] as const,
  submissions: (id: string, page: number) =>
    ["admin-users", id, "submissions", page] as const,
  notes: (id: string, page: number) =>
    ["admin-users", id, "notes", page] as const,
}

function toQueryString(filters: AdminUserListQuery): string {
  const params = new URLSearchParams()
  if (filters.q) params.set("q", filters.q)
  if (filters.status) params.set("status", filters.status)
  if (filters.adminRole) params.set("adminRole", filters.adminRole)
  if (filters.emailVerified !== undefined) {
    params.set("emailVerified", String(filters.emailVerified))
  }
  params.set("page", String(filters.page))
  params.set("perPage", String(filters.perPage))
  params.set("sort", filters.sort)
  return params.toString()
}

export function useAdminUsers(
  filters: AdminUserListQuery,
  initialData?: AdminUsersListResponse
) {
  return useQuery({
    queryKey: adminUserKeys.list(filters),
    queryFn: () =>
      apiFetch<AdminUsersListResponse>(
        `/api/v1/admin/users?${toQueryString(filters)}`
      ),
    initialData,
  })
}

export function useAdminUser(id: string, initialData?: AdminUserDetail) {
  return useQuery({
    queryKey: adminUserKeys.detail(id),
    queryFn: () => apiFetch<AdminUserDetail>(`/api/v1/admin/users/${id}`),
    initialData,
  })
}

export function useAdminUserSubmissions(userId: string, page = 1) {
  return useQuery({
    queryKey: adminUserKeys.submissions(userId, page),
    queryFn: () =>
      apiFetch<AdminUserSubmissionsResponse>(
        `/api/v1/admin/users/${userId}/submissions?page=${page}`
      ),
  })
}

export function useAdminUserNotes(userId: string, page = 1) {
  return useQuery({
    queryKey: adminUserKeys.notes(userId, page),
    queryFn: () =>
      apiFetch<{
        notes: AdminUserDetail["notes"]
        total: number
        page: number
        perPage: number
        totalPages: number
      }>(`/api/v1/admin/users/${userId}/notes?page=${page}`),
  })
}

// Full submission content for one row in the submissions tab. The route
// requires VIEW_SENSITIVE_SUBMISSIONS and logs the access, so this
// query is only enabled when a submission is actually being revealed
// (submissionId !== null) — never prefetched for the whole list.
export type AdminUserSubmissionDetail = {
  id: string
  formId: string
  status: string
  data: Record<string, unknown>
  originDomain: string
  createdAt: Date
  updatedAt: Date
  form: { id: string; name: string }
}

export function useAdminUserSubmission(
  userId: string,
  submissionId: string | null
) {
  return useQuery({
    queryKey: ["admin-users", userId, "submissions", submissionId],
    queryFn: () =>
      apiFetch<AdminUserSubmissionDetail>(
        `/api/v1/admin/users/${userId}/submissions/${submissionId}`
      ),
    enabled: submissionId !== null,
  })
}

// ─── Mutations ────────────────────────────────────────────────────────
// Every mutation invalidates the users list + the affected detail query
// on success, so the admin UI never shows stale status/role data.

function useAdminUserMutation(userId: string) {
  const qc = useQueryClient()
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin-users"] })
    qc.invalidateQueries({ queryKey: adminUserKeys.detail(userId) })
  }
  return {
    onSuccess: invalidate,
    // DOC-003 approve/reject invalidate onSettled (not just on
    // success) — the status transition is server-authoritative and
    // the list must refetch even when the mutation fails.
    onSettled: invalidate,
  }
}

export function useSuspendUser(userId: string) {
  const { onSuccess } = useAdminUserMutation(userId)
  return useMutation({
    mutationFn: (body: { reason: string }) =>
      apiFetch(`/api/v1/admin/users/${userId}/suspend`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess,
  })
}

export function useReactivateUser(userId: string) {
  const { onSuccess } = useAdminUserMutation(userId)
  return useMutation({
    mutationFn: (body: { reason?: string }) =>
      apiFetch(`/api/v1/admin/users/${userId}/reactivate`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess,
  })
}

export function useDisableUser(userId: string) {
  const { onSuccess } = useAdminUserMutation(userId)
  return useMutation({
    mutationFn: (body: { reason: string }) =>
      apiFetch(`/api/v1/admin/users/${userId}/disable`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess,
  })
}

export function useRestoreUser(userId: string) {
  const { onSuccess } = useAdminUserMutation(userId)
  return useMutation({
    mutationFn: (body: { reason?: string }) =>
      apiFetch(`/api/v1/admin/users/${userId}/restore`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess,
  })
}

// DOC-003: approve / reject a user awaiting approval. No optimistic
// update — status transitions are server-authoritative; the list
// refetches onSettled.
export function useApproveUser(userId: string) {
  const { onSettled } = useAdminUserMutation(userId)
  return useMutation({
    mutationFn: (body: { reason?: string }) =>
      apiFetch(`/api/v1/admin/users/${userId}/approve`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSettled,
  })
}

export function useRejectUser(userId: string) {
  const { onSettled } = useAdminUserMutation(userId)
  return useMutation({
    mutationFn: (body: { reason: string }) =>
      apiFetch(`/api/v1/admin/users/${userId}/reject`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSettled,
  })
}

export function useSetAdminRole(userId: string) {
  const { onSuccess } = useAdminUserMutation(userId)
  return useMutation({
    mutationFn: (body: {
      adminRole: "SUPER_ADMIN" | "MANAGER" | "SUPPORT" | null
    }) =>
      apiFetch(`/api/v1/admin/users/${userId}/role`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess,
  })
}

export function useRevokeUserApiKeys(userId: string) {
  const { onSuccess } = useAdminUserMutation(userId)
  return useMutation({
    mutationFn: () =>
      apiFetch<{ count: number }>(`/api/v1/admin/users/${userId}/revoke-keys`, {
        method: "POST",
      }),
    onSuccess,
  })
}

export function useRevokeUserSessions(userId: string) {
  const { onSuccess } = useAdminUserMutation(userId)
  return useMutation({
    mutationFn: () =>
      apiFetch<{ count: number }>(
        `/api/v1/admin/users/${userId}/revoke-sessions`,
        { method: "POST" }
      ),
    onSuccess,
  })
}

export function useRequireEmailVerification(userId: string) {
  const { onSuccess } = useAdminUserMutation(userId)
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/v1/admin/users/${userId}/require-verification`, {
        method: "POST",
      }),
    onSuccess,
  })
}

export function useTriggerPasswordReset(userId: string) {
  const { onSuccess } = useAdminUserMutation(userId)
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/v1/admin/users/${userId}/password-reset`, {
        method: "POST",
      }),
    onSuccess,
  })
}

export function useAddAdminNote(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { body: string }) =>
      apiFetch(`/api/v1/admin/users/${userId}/notes`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] })
      qc.invalidateQueries({ queryKey: adminUserKeys.detail(userId) })
      qc.invalidateQueries({
        queryKey: ["admin-users", userId, "notes"],
      })
    },
  })
}

export function useRequestDeletion(userId: string) {
  const { onSuccess } = useAdminUserMutation(userId)
  return useMutation({
    mutationFn: (body: { reason: string }) =>
      apiFetch(`/api/v1/admin/users/${userId}/deletion-request`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess,
  })
}

// Export is a GET (it audits the access) but behaves like an action from
// the UI's point of view, so it is a mutation that fetches the JSON.
export function useExportUserData(userId: string) {
  return useMutation({
    mutationFn: () =>
      apiFetch<Record<string, unknown>>(`/api/v1/admin/users/${userId}/export`),
  })
}
