"use client"

import { useMutation } from "@tanstack/react-query"
import { apiFetch, awaitWithTimeout } from "@sendcms/shared"
import type { LocaleCode } from "@/lib/i18n-client"

/**
 * Best-effort locale persistence: POST the chosen locale to the API
 * (`POST /api/v1/users/me/locale`, Phase 2). The cookie already holds
 * the choice, so a missing route (404) or a signed-out user (401) is not
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

/** Minimal shape of the persist mutation the await helper needs. */
export type PersistLocaleMutation = {
  mutateAsync: (locale: LocaleCode) => Promise<unknown>
}

/**
 * Await the DB persist before a navigation (I18N-308). A plain
 * fire-and-forget fetch is not guaranteed to complete across a
 * navigation, so the language switch used to reload while the POST was
 * still in flight and the DB write could be lost while the cookie
 * survived — the choice then looked saved until a new browser or
 * cleared cookies, when the DB still held the old locale (DSH-001).
 * Resolves once the POST lands, once `timeoutMs` elapses (default
 * 2 s — a slow API never blocks the switch), or immediately when the
 * POST fails (silenced by design: the cookie already holds the
 * choice). The race itself lives in `@sendcms/shared`
 * (`awaitWithTimeout`, client-safe) so tests can cover it without
 * importing app code.
 */
export async function awaitPersistLocale(
  mutation: PersistLocaleMutation,
  locale: LocaleCode,
  timeoutMs = 2000
): Promise<void> {
  try {
    await awaitWithTimeout(mutation.mutateAsync(locale), timeoutMs)
  } catch {
    // Silenced by design (see usePersistLocale).
  }
}
