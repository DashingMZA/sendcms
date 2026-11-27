import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"

/** Manual "Run now" (Seven Admin Pages, Phase C, plan §3.6): runs
    the email-outbox cron through the same path as the Vercel cron
    and records a MANUAL CronRun row. MANAGE_JOBS + step-up re-auth
    are enforced by the service; the call site opens the StepUpDialog
    first and runs this mutation only onVerified — the payments
    refund flow, not a new pattern. */
export function useRunCronNow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<{ id: string; status: string }>(
        "/api/v1/admin/jobs/cron-runs/run",
        { method: "POST", body: JSON.stringify({}) }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cron-runs"] })
    },
  })
}
