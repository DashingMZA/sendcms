"use client"

import { useMutation } from "@tanstack/react-query"
import { apiFetch } from "@sendcms/shared"
import type { LocaleCode } from "@/lib/i18n-client"

/**
 * Best-effort locale persistence: POST the chosen locale to the API
 * (the `/api/v1/users/me/locale` route lands as a follow-up to this
 * scaffold — the parent builds it). The cookie already holds the
 * choice, so a missing route (404) or a signed-out user (401) is not
 * an error for the UI: the mutation is silenced and never throws.
 */
export function usePersistLocale() {
  return useMutation({
    mutationFn: (locale: LocaleCode) =>
      apiFetch("/api/v1/users/me/locale", {
        method: "POST",
        body: JSON.stringify({ locale }),
      }),
    meta: { silent: true },
  })
}
