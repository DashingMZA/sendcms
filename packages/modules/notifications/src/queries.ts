import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type { EmailJobListResult } from "./service"

export type { EmailJobListResult }

export type EmailJobListParams = {
  status?: "PENDING" | "SENDING" | "SENT" | "FAILED"
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

/** Requeues a FAILED or stuck-SENDING job from the delivery log
    (Phase 16, EML-094/095). The error message is the server's (a
    within-lease SENDING refusal names the lease), so the call site
    should surface `err.message` — see the inbox ReplySection. */
export function useRequeueEmailJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (jobId: string) =>
      apiFetch<{ id: string; status: string }>(
        `/api/v1/email-jobs/${jobId}/requeue`,
        { method: "POST" }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["email-jobs"] })
    },
  })
}
