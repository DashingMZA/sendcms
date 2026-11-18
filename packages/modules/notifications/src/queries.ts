import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type { EmailJobListResult } from "./service"

export type { EmailJobListResult }

export type EmailJobListParams = {
  status?: "PENDING" | "SENT" | "FAILED"
  formId?: string
  page?: number
}

export const emailJobKeys = {
  list: (params: EmailJobListParams) => ["email-jobs", params] as const,
}

function toQueryString(params: EmailJobListParams): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      query.set(key, String(value))
    }
  }
  const text = query.toString()
  return text ? `?${text}` : ""
}

export function useEmailJobs(
  params: EmailJobListParams,
  initialData?: EmailJobListResult
) {
  return useQuery({
    queryKey: emailJobKeys.list(params),
    queryFn: () =>
      apiFetch<EmailJobListResult>(
        `/api/v1/email-jobs${toQueryString(params)}`
      ),
    initialData,
  })
}

export function useSendTestEmail(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (to: string) =>
      apiFetch<{ messageId: string; provider: string }>(
        `/api/v1/forms/${formId}/test-email`,
        { method: "POST", body: JSON.stringify({ to }) }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["email-jobs"] })
    },
  })
}
