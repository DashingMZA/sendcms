import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type { FormDetail, FormWithCounts } from "./service"
import type {
  FormDomain,
  FormField,
  NotificationSettings,
} from "@sendcms/database"

import type {
  AddNotificationEmailInput,
  CreateFieldInput,
  CreateFormInput,
  UpdateFieldInput,
  UpdateFormInput,
} from "./validators"

export type { FormDetail, FormWithCounts }

export const formKeys = {
  list: ["forms"] as const,
  detail: (id: string) => ["forms", id] as const,
}

export function useForms(initialData?: FormWithCounts[]) {
  return useQuery({
    queryKey: formKeys.list,
    queryFn: () => apiFetch<FormWithCounts[]>("/api/v1/forms"),
    initialData,
  })
}

export function useForm(id: string, initialData?: FormDetail) {
  return useQuery({
    queryKey: formKeys.detail(id),
    queryFn: () => apiFetch<FormDetail>(`/api/v1/forms/${id}`),
    initialData,
  })
}

function invalidateForm(qc: ReturnType<typeof useQueryClient>, id?: string) {
  qc.invalidateQueries({ queryKey: formKeys.list })
  if (id) qc.invalidateQueries({ queryKey: formKeys.detail(id) })
}

export function useCreateForm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateFormInput) =>
      apiFetch<FormDetail>("/api/v1/forms", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateForm(qc),
  })
}

export function useUpdateForm(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateFormInput) =>
      apiFetch<FormDetail>(`/api/v1/forms/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (updated) => {
      qc.setQueryData(formKeys.detail(id), updated)
      invalidateForm(qc, id)
    },
  })
}

export function useDeleteForm(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/v1/forms/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateForm(qc),
  })
}

export function useAddField(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateFieldInput) =>
      apiFetch<FormField>(`/api/v1/forms/${formId}/fields`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateForm(qc, formId),
  })
}

export function useUpdateField(formId: string, fieldId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateFieldInput) =>
      apiFetch<FormField>(`/api/v1/forms/${formId}/fields/${fieldId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateForm(qc, formId),
  })
}

export function useDeleteField(formId: string, fieldId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/v1/forms/${formId}/fields/${fieldId}`, {
        method: "DELETE",
      }),
    onSuccess: () => invalidateForm(qc, formId),
  })
}

export function useLinkDomain(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { domainId: string }) =>
      apiFetch<FormDomain>(`/api/v1/forms/${formId}/domains`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateForm(qc, formId),
  })
}

export function useUnlinkDomain(formId: string, domainId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/v1/forms/${formId}/domains/${domainId}`, {
        method: "DELETE",
      }),
    onSuccess: () => invalidateForm(qc, formId),
  })
}

export function useAddNotificationEmail(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: AddNotificationEmailInput) =>
      apiFetch<NotificationSettings>(`/api/v1/forms/${formId}/notifications`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateForm(qc, formId),
  })
}

export function useUpdateNotificationEmail(
  formId: string,
  notificationId: string
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { enabled: boolean }) =>
      apiFetch<NotificationSettings>(
        `/api/v1/forms/${formId}/notifications/${notificationId}`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        }
      ),
    onSuccess: () => invalidateForm(qc, formId),
  })
}

export function useDeleteNotificationEmail(
  formId: string,
  notificationId: string
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<void>(
        `/api/v1/forms/${formId}/notifications/${notificationId}`,
        { method: "DELETE" }
      ),
    onSuccess: () => invalidateForm(qc, formId),
  })
}
