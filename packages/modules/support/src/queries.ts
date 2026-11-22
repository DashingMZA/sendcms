"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type {
  AdminTicketsPage,
  MyTicketsPage,
  StaffUserRow,
  TicketDetailRow,
} from "./service"
import type {
  AssignTicketInput,
  CreateTicketInput,
  ReplyToTicketInput,
  SetTicketStatusInput,
} from "./validators"

// React Query hooks for the support pages (/dashboard/support/* and
// /admin/support/*). The API base is the same @sendcms/shared apiFetch
// the other modules use; the dashboard and admin apps reach the api
// app through their /api/v1/* rewrite proxies. Keys are the
// invalidation unit.

export const SUPPORT_KEYS = {
  myTickets: (filters: Record<string, string | number | undefined>) =>
    ["support-my-tickets", filters] as const,
  myTicket: (ticketId: string) => ["support-my-ticket", ticketId] as const,
  adminTickets: (filters: Record<string, string | number | undefined>) =>
    ["support-admin-tickets", filters] as const,
  adminTicket: (ticketId: string) =>
    ["support-admin-ticket", ticketId] as const,
}

function toQueryString(filters: Record<string, string | number | undefined>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) params.set(key, String(value))
  }
  return params.toString()
}

// ─── Customer ───────────────────────────────────────────────────────────

export function useMyTickets(
  filters: {
    status?:
      "OPEN" | "IN_PROGRESS" | "WAITING_ON_CUSTOMER" | "RESOLVED" | "CLOSED"
    page?: number
    perPage?: number
  },
  initialData?: MyTicketsPage
) {
  return useQuery({
    queryKey: SUPPORT_KEYS.myTickets(filters),
    queryFn: () => {
      const query = toQueryString(filters)
      return apiFetch<MyTicketsPage>(
        `/api/v1/support/tickets${query ? `?${query}` : ""}`
      )
    },
    initialData,
  })
}

export function useMyTicket(ticketId: string, initialData?: TicketDetailRow) {
  return useQuery({
    queryKey: SUPPORT_KEYS.myTicket(ticketId),
    queryFn: () =>
      apiFetch<TicketDetailRow>(`/api/v1/support/tickets/${ticketId}`),
    enabled: Boolean(ticketId),
    initialData,
  })
}

export function useCreateTicket() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateTicketInput) =>
      apiFetch<TicketDetailRow>("/api/v1/support/tickets", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["support-my-tickets"] })
    },
  })
}

export function useReplyToMyTicket(ticketId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ReplyToTicketInput) =>
      apiFetch<TicketDetailRow>(`/api/v1/support/tickets/${ticketId}/reply`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: SUPPORT_KEYS.myTicket(ticketId),
      })
      queryClient.invalidateQueries({ queryKey: ["support-my-tickets"] })
    },
  })
}

// ─── Admin ──────────────────────────────────────────────────────────────

export function useAdminTickets(
  filters: {
    status?:
      "OPEN" | "IN_PROGRESS" | "WAITING_ON_CUSTOMER" | "RESOLVED" | "CLOSED"
    priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT"
    assignedToId?: string
    search?: string
    page?: number
    perPage?: number
  },
  initialData?: AdminTicketsPage
) {
  return useQuery({
    queryKey: SUPPORT_KEYS.adminTickets(filters),
    queryFn: () => {
      const query = toQueryString(filters)
      return apiFetch<AdminTicketsPage>(
        `/api/v1/admin/support/tickets${query ? `?${query}` : ""}`
      )
    },
    initialData,
  })
}

export function useAdminTicket(
  ticketId: string,
  initialData?: TicketDetailRow
) {
  return useQuery({
    queryKey: SUPPORT_KEYS.adminTicket(ticketId),
    queryFn: () =>
      apiFetch<TicketDetailRow>(`/api/v1/admin/support/tickets/${ticketId}`),
    enabled: Boolean(ticketId),
    initialData,
  })
}

export function useAdminReplyToTicket(ticketId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ReplyToTicketInput) =>
      apiFetch<TicketDetailRow>(
        `/api/v1/admin/support/tickets/${ticketId}/reply`,
        { method: "POST", body: JSON.stringify(input) }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: SUPPORT_KEYS.adminTicket(ticketId),
      })
      queryClient.invalidateQueries({ queryKey: ["support-admin-tickets"] })
    },
  })
}

export function useSetTicketStatus(ticketId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SetTicketStatusInput) =>
      apiFetch<TicketDetailRow>(
        `/api/v1/admin/support/tickets/${ticketId}/status`,
        { method: "POST", body: JSON.stringify(input) }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: SUPPORT_KEYS.adminTicket(ticketId),
      })
      queryClient.invalidateQueries({ queryKey: ["support-admin-tickets"] })
    },
  })
}

export function useStaffUsers(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["support-staff-users"],
    queryFn: () => apiFetch<StaffUserRow[]>("/api/v1/admin/support/staff"),
    enabled: options?.enabled ?? true,
  })
}

export function useAssignTicket(ticketId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: AssignTicketInput) =>
      apiFetch<TicketDetailRow>(
        `/api/v1/admin/support/tickets/${ticketId}/assign`,
        { method: "POST", body: JSON.stringify(input) }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: SUPPORT_KEYS.adminTicket(ticketId),
      })
      queryClient.invalidateQueries({ queryKey: ["support-admin-tickets"] })
    },
  })
}
