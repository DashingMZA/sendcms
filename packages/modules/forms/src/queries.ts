import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type { FormDetail, FormListResult, FormWithCounts } from "./service"
import type {
  FormDomain,
  FormField,
  FormFieldType,
  NotificationSettings,
} from "@sendcms/database"

import type {
  AddNotificationEmailInput,
  CreateFieldInput,
  CreateFormInput,
  FormListQueryInput,
  UpdateFieldInput,
  UpdateFormInput,
} from "./validators"

export type { FormDetail, FormListResult, FormWithCounts }

export type { FormListQueryInput }

/** Form detail as the API returns it: the stored detail plus the
    server's Turnstile configuration state (SDK-016) — the dashboard
    process cannot know the API server's secret, so the flag comes
    from the API and the form page warns when Turnstile is on but the
    server cannot verify tokens. */
export type FormDetailResponse = FormDetail & {
  turnstileConfigured?: boolean
}

export const formKeys = {
  list: ["forms"] as const,
  page: (params: FormListQueryInput) => ["forms", "page", params] as const,
  detail: (id: string) => ["forms", id] as const,
}

export function useForms(initialData?: FormWithCounts[]) {
  return useQuery({
    queryKey: formKeys.list,
    queryFn: () => apiFetch<FormWithCounts[]>("/api/v1/forms"),
    initialData,
  })
}

// DSH-107: the paged list the dashboard tables use — search, sort and
// pagination ride in the URL (the page passes its parsed params in),
// so the table refetches when the user pages or searches. The key
// nests under formKeys.list, so the create/update/delete mutations'
// invalidateQueries({ queryKey: formKeys.list }) refreshes paged
// lists too.
export function useFormsPage(
  params: FormListQueryInput,
  initialData?: FormListResult
) {
  return useQuery({
    queryKey: formKeys.page(params),
    queryFn: () =>
      apiFetch<FormListResult>(`/api/v1/forms${toQueryString(params)}`),
    initialData,
  })
}

function toQueryString(params: FormListQueryInput): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      query.set(key, String(value))
    }
  }
  const text = query.toString()
  return text ? `?${text}` : ""
}

export function useForm(id: string, initialData?: FormDetailResponse) {
  return useQuery({
    queryKey: formKeys.detail(id),
    queryFn: () => apiFetch<FormDetailResponse>(`/api/v1/forms/${id}`),
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
    // SRC-208: the form name travels as the confirmation token — the
    // service archives the form only when it matches.
    mutationFn: (confirmation: string) =>
      apiFetch<void>(`/api/v1/forms/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmation }),
      }),
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

/** AI-assisted form building (Phase 12, Step 4). Suggests fields from
    a plain-language description; the owner reviews the suggestions
    before any field is created — this hook never creates a field. */
export type AiFieldSuggestion = {
  name: string
  label: string
  type: FormFieldType
  required: boolean
  placeholder?: string
  options?: string[]
}

export function useSuggestFields(formId: string) {
  return useMutation({
    mutationFn: (prompt: string) =>
      apiFetch<{ fields: AiFieldSuggestion[] }>(
        `/api/v1/forms/${formId}/ai/suggest-fields`,
        {
          method: "POST",
          body: JSON.stringify({ prompt }),
        }
      ),
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

/** Re-sends the confirmation email for an unconfirmed recipient
    (EML-004 — expired link, lost email). */
export function useResendNotificationConfirmation(
  formId: string,
  notificationId: string
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<NotificationSettings>(
        `/api/v1/forms/${formId}/notifications/${notificationId}/resend`,
        { method: "POST" }
      ),
    onSuccess: () => invalidateForm(qc, formId),
  })
}
