"use client"

import { useMutation } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"

// Step-up verification (Admin Control Plane, Phase 9): POST the
// admin's password to the verify route. The route checks it against
// the credential Account row and records a verification row valid
// for 10 minutes; the high-impact action then runs inside that
// window. The mutation is silent: the step-up dialog shows its own
// inline error (wrong password / no password set / too many
// attempts) instead of the global toast.
export type StepUpVerifyResponse = {
  verifiedUntil: string
}

export function useVerifyStepUp() {
  return useMutation({
    mutationFn: (password: string) =>
      apiFetch<StepUpVerifyResponse>("/api/v1/admin/step-up/verify", {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
    meta: { silent: true },
  })
}
