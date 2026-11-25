// Client-safe async helpers (no server imports — this file is
// imported by client components, so it must stay free of `db`,
// `fs`, and other Node-only modules).

/**
 * Wait for a promise, but stop waiting after `timeoutMs` (I18N-308).
 * Resolves with the promise's value when it lands first, or with
 * `undefined` when the timeout wins; rejects when the promise rejects
 * first. The timeout only stops *waiting* — it never cancels the
 * promise, which keeps running in the background. The timer is
 * cleared as soon as the race settles, so no handle lingers.
 *
 * Used by the language switch: the locale persist POST must land
 * before `window.location.reload()`, but a slow API must never block
 * the switch — a plain fire-and-forget fetch is not guaranteed to
 * complete across a navigation, so the DB write could be lost while
 * the cookie survived.
 */
export async function awaitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
