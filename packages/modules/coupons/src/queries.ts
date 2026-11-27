import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type { CouponRedemptionRow, CouponSummary } from "./service"
import type {
  CouponsQuery,
  CreateCouponInput,
  UpdateCouponInput,
} from "./validators"

// React Query hooks for the admin coupons page (Seven Admin Pages,
// Phase D, plan §3.7 — Stream B consumes these). Same pattern as
// @sendcms/billing/queries: the hook key names the resource, the
// fetcher hits the API (proxied to the api app), and errors surface
// as ApiClientError objects with status. Never fetch raw in a
// component. This file is imported by client components, so it must
// never import the database client or the service — type-only imports
// from ./service are the boundary.

export const couponKeys = {
  all: ["coupons"] as const,
  list: (filters: CouponsQuery) => ["coupons", "list", filters] as const,
  detail: (id: string) => ["coupons", id] as const,
  redemptions: (id: string, page: number, perPage: number) =>
    ["coupons", id, "redemptions", page, perPage] as const,
}

export type CouponsListResponse = {
  coupons: CouponSummary[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export type CouponRedemptionsResponse = {
  redemptions: CouponRedemptionRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export function useCoupons(
  filters: CouponsQuery,
  initialData?: CouponsListResponse
) {
  return useQuery({
    queryKey: couponKeys.list(filters),
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(filters.page),
        perPage: String(filters.perPage),
        status: filters.status,
        ...(filters.search ? { search: filters.search } : {}),
      })
      return apiFetch<CouponsListResponse>(
        `/api/v1/admin/coupons?${params.toString()}`
      )
    },
    initialData,
  })
}

export function useCoupon(id: string, initialData?: CouponSummary) {
  return useQuery({
    queryKey: couponKeys.detail(id),
    queryFn: () => apiFetch<CouponSummary>(`/api/v1/admin/coupons/${id}`),
    initialData,
  })
}

export function useCouponRedemptions(
  couponId: string,
  page = 1,
  perPage = 20,
  initialData?: CouponRedemptionsResponse
) {
  return useQuery({
    queryKey: couponKeys.redemptions(couponId, page, perPage),
    queryFn: () =>
      apiFetch<CouponRedemptionsResponse>(
        `/api/v1/admin/coupons/${couponId}/redemptions?page=${page}&perPage=${perPage}`
      ),
    initialData,
  })
}

export function useCreateCoupon() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateCouponInput) =>
      apiFetch<CouponSummary>("/api/v1/admin/coupons", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: couponKeys.all }),
  })
}

export function useDisableCoupon(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<CouponSummary>(`/api/v1/admin/coupons/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "DISABLED" }),
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: couponKeys.detail(id) })
      qc.invalidateQueries({ queryKey: couponKeys.all })
    },
  })
}

// Field edits + re-enable (PATCH). The deal itself (code,
// discountType, discountValue, currency) is not mutable — the
// schema rejects those keys with 422.
export function useUpdateCoupon(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateCouponInput) =>
      apiFetch<CouponSummary>(`/api/v1/admin/coupons/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: couponKeys.detail(id) })
      qc.invalidateQueries({ queryKey: couponKeys.all })
    },
  })
}

export function useDeleteCoupon() {
  const qc = useQueryClient()
  return useMutation({
    // 204: no body — apiFetch resolves undefined on 204.
    mutationFn: (couponId: string) =>
      apiFetch<void>(`/api/v1/admin/coupons/${couponId}`, {
        method: "DELETE",
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: couponKeys.all }),
  })
}
