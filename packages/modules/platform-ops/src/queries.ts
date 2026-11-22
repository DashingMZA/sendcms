"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type {
  AnnouncementRow,
  FeatureFlagOverrideRow,
  FeatureFlagRow,
  PlatformHealth,
  PlatformSubmissionDetail,
  PlatformSubmissionRow,
  SpamStats,
  SystemSummary,
} from "./service"
import type { AuditLogRow } from "./audit"
import type { DeletionRequestRow } from "./deletion"
import type { TranslationLocaleCompletion } from "./translations"
import type {
  CreateAnnouncementInput,
  CreateFlagInput,
  ExecuteErasureInput,
  ReviewDeletionRequestInput,
  SetAnnouncementActiveInput,
  SetFlagInput,
  SetFlagOverrideInput,
  UpdateAnnouncementInput,
  UpdatePlatformSubmissionStatusInput,
} from "./validators"

// React Query hooks for the admin operations pages
// (/admin/features, /admin/announcements, /admin/audit-logs,
// /admin/health, /admin/submissions, /admin/security,
// /admin/translations). The API base is the same @sendcms/shared
// apiFetch the other modules use; the api app is reached through the
// admin app's /api/v1/* rewrite proxy (or directly).

export const PLATFORM_OPS_KEYS = {
  flags: ["platform-flags"] as const,
  flagOverrides: (key: string) => ["platform-flag-overrides", key] as const,
  announcements: ["platform-announcements"] as const,
  activeAnnouncements: ["platform-announcements-active"] as const,
  auditLogs: (filters: Record<string, string | number | undefined>) =>
    ["platform-audit-logs", filters] as const,
  auditLog: (id: string) => ["platform-audit-log", id] as const,
  health: ["platform-health"] as const,
  system: ["platform-system"] as const,
  submissions: (filters: Record<string, string | number | undefined>) =>
    ["platform-submissions", filters] as const,
  submission: (id: string) => ["platform-submission", id] as const,
  spamStats: ["platform-spam-stats"] as const,
  deletionRequests: (filters: Record<string, string | number | undefined>) =>
    ["platform-deletion-requests", filters] as const,
  translations: ["platform-translations"] as const,
}

function toQueryString(filters: Record<string, string | number | undefined>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const query = params.toString()
  return query ? `?${query}` : ""
}

// ─── Feature flags ────────────────────────────────────────────────────

export function useFeatureFlags() {
  return useQuery({
    queryKey: PLATFORM_OPS_KEYS.flags,
    queryFn: () =>
      apiFetch<{ flags: FeatureFlagRow[] }>("/api/v1/admin/features"),
  })
}

export function useCreateFeatureFlag() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateFlagInput) =>
      apiFetch<FeatureFlagRow>("/api/v1/admin/features", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PLATFORM_OPS_KEYS.flags })
    },
  })
}

export function useSetFeatureFlag(key: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SetFlagInput) =>
      apiFetch<FeatureFlagRow>(`/api/v1/admin/features/${key}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PLATFORM_OPS_KEYS.flags })
    },
  })
}

export function useFlagOverrides(key: string) {
  return useQuery({
    queryKey: PLATFORM_OPS_KEYS.flagOverrides(key),
    queryFn: () =>
      apiFetch<{ overrides: FeatureFlagOverrideRow[] }>(
        `/api/v1/admin/features/${key}/overrides`
      ),
    enabled: Boolean(key),
  })
}

export function useSetFlagOverride(key: string, userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SetFlagOverrideInput) =>
      apiFetch<FeatureFlagOverrideRow>(
        `/api/v1/admin/features/${key}/overrides`,
        {
          method: "POST",
          body: JSON.stringify({ ...input, userId }),
        }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: PLATFORM_OPS_KEYS.flagOverrides(key),
      })
    },
  })
}

export function useRemoveFlagOverride(key: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<{ removed: boolean }>(
        `/api/v1/admin/features/${key}/overrides/${userId}`,
        { method: "DELETE" }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: PLATFORM_OPS_KEYS.flagOverrides(key),
      })
    },
  })
}

// ─── Announcements ────────────────────────────────────────────────────

export function useAnnouncements() {
  return useQuery({
    queryKey: PLATFORM_OPS_KEYS.announcements,
    queryFn: () =>
      apiFetch<{
        announcements: AnnouncementRow[]
        total: number
        page: number
        perPage: number
        totalPages: number
      }>("/api/v1/admin/announcements"),
  })
}

export function useCreateAnnouncement() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateAnnouncementInput) =>
      apiFetch<AnnouncementRow>("/api/v1/admin/announcements", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: PLATFORM_OPS_KEYS.announcements,
      })
    },
  })
}

export function useUpdateAnnouncement(announcementId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateAnnouncementInput) =>
      apiFetch<AnnouncementRow>(
        `/api/v1/admin/announcements/${announcementId}`,
        { method: "PATCH", body: JSON.stringify(input) }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: PLATFORM_OPS_KEYS.announcements,
      })
    },
  })
}

export function useSetAnnouncementActive(announcementId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SetAnnouncementActiveInput) =>
      apiFetch<AnnouncementRow>(
        `/api/v1/admin/announcements/${announcementId}`,
        { method: "PATCH", body: JSON.stringify(input) }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: PLATFORM_OPS_KEYS.announcements,
      })
    },
  })
}

export function useActiveAnnouncements() {
  return useQuery({
    queryKey: PLATFORM_OPS_KEYS.activeAnnouncements,
    queryFn: () =>
      apiFetch<{ announcements: AnnouncementRow[] }>(
        "/api/v1/announcements/active"
      ),
  })
}

// ─── Audit trail ──────────────────────────────────────────────────────

export function useAuditLogs(filters: {
  actorId?: string
  targetUserId?: string
  action?: string
  resourceType?: string
  outcome?: string
  correlationId?: string
  from?: string
  to?: string
  page?: number
  perPage?: number
}) {
  return useQuery({
    queryKey: PLATFORM_OPS_KEYS.auditLogs(filters),
    queryFn: () =>
      apiFetch<{
        logs: AuditLogRow[]
        total: number
        page: number
        perPage: number
        totalPages: number
      }>(`/api/v1/admin/audit-logs${toQueryString(filters)}`),
  })
}

export function useAuditLog(id: string) {
  return useQuery({
    queryKey: PLATFORM_OPS_KEYS.auditLog(id),
    queryFn: () => apiFetch<AuditLogRow>(`/api/v1/admin/audit-logs/${id}`),
    enabled: Boolean(id),
  })
}

// ─── Health + system ──────────────────────────────────────────────────

export function usePlatformHealth() {
  return useQuery({
    queryKey: PLATFORM_OPS_KEYS.health,
    queryFn: () => apiFetch<PlatformHealth>("/api/v1/admin/health"),
  })
}

export function useSystemSummary() {
  return useQuery({
    queryKey: PLATFORM_OPS_KEYS.system,
    queryFn: () => apiFetch<SystemSummary>("/api/v1/admin/system"),
  })
}

// ─── Abuse / spam queue ───────────────────────────────────────────────

export function usePlatformSubmissions(filters: {
  status?: "NEW" | "READ" | "STARRED" | "ARCHIVED" | "SPAM"
  formId?: string
  userId?: string
  search?: string
  from?: string
  to?: string
  page?: number
  perPage?: number
}) {
  return useQuery({
    queryKey: PLATFORM_OPS_KEYS.submissions(filters),
    queryFn: () =>
      apiFetch<{
        submissions: PlatformSubmissionRow[]
        total: number
        page: number
        perPage: number
        totalPages: number
      }>(`/api/v1/admin/submissions${toQueryString(filters)}`),
  })
}

export function usePlatformSubmission(submissionId: string) {
  return useQuery({
    queryKey: PLATFORM_OPS_KEYS.submission(submissionId),
    queryFn: () =>
      apiFetch<PlatformSubmissionDetail>(
        `/api/v1/admin/submissions/${submissionId}`
      ),
    enabled: Boolean(submissionId),
  })
}

export function useSpamStats() {
  return useQuery({
    queryKey: PLATFORM_OPS_KEYS.spamStats,
    queryFn: () => apiFetch<SpamStats>("/api/v1/admin/submissions/stats"),
  })
}

export function useUpdatePlatformSubmissionStatus(submissionId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdatePlatformSubmissionStatusInput) =>
      apiFetch<{ id: string; status: string; changed: boolean }>(
        `/api/v1/admin/submissions/${submissionId}/status`,
        { method: "POST", body: JSON.stringify(input) }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["platform-submissions"],
      })
      queryClient.invalidateQueries({
        queryKey: PLATFORM_OPS_KEYS.submission(submissionId),
      })
      queryClient.invalidateQueries({
        queryKey: PLATFORM_OPS_KEYS.spamStats,
      })
    },
  })
}

// ─── Deletion workflow ────────────────────────────────────────────────

export function useDeletionRequests(filters: {
  status?: "REQUESTED" | "APPROVED" | "REJECTED" | "COMPLETED"
  page?: number
  perPage?: number
}) {
  return useQuery({
    queryKey: PLATFORM_OPS_KEYS.deletionRequests(filters),
    queryFn: () =>
      apiFetch<{
        requests: DeletionRequestRow[]
        total: number
        page: number
        perPage: number
        totalPages: number
      }>(`/api/v1/admin/deletion-requests${toQueryString(filters)}`),
  })
}

export function useReviewDeletionRequest(requestId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ReviewDeletionRequestInput) =>
      apiFetch<DeletionRequestRow>(
        `/api/v1/admin/deletion-requests/${requestId}/review`,
        { method: "POST", body: JSON.stringify(input) }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["platform-deletion-requests"],
      })
    },
  })
}

export function useExecuteErasure(requestId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ExecuteErasureInput) =>
      apiFetch<DeletionRequestRow>(
        `/api/v1/admin/deletion-requests/${requestId}/erase`,
        { method: "POST", body: JSON.stringify(input) }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["platform-deletion-requests"],
      })
    },
  })
}

// ─── Translation completion ───────────────────────────────────────────

export function useTranslationCompletion() {
  return useQuery({
    queryKey: PLATFORM_OPS_KEYS.translations,
    queryFn: () =>
      apiFetch<{ locales: TranslationLocaleCompletion[] }>(
        "/api/v1/admin/translations"
      ),
  })
}
