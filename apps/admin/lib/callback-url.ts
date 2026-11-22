/**
 * Absolute callback URL for auth flows (`/admin` on this app).
 *
 * The auth handler lives in the api app, so its SERVER-side redirects
 * (the email verification link, the OAuth callback) must point back at
 * THIS app by absolute URL — a relative "/admin" would resolve on the
 * api app's origin and 404. The forms that pass a callbackURL are
 * client components, so the page's own origin is the admin app's URL
 * (dev: http://localhost:3006; production: the admin's public URL) —
 * no env var to keep in sync.
 *
 * The admin host is env-driven (NEXT_PUBLIC_ADMIN_URL) and NEVER
 * hardcoded — the owner will move to a .com domain later.
 */
export function adminCallbackURL(): string {
  // Client components render on the server too (SSR), where `window`
  // does not exist — fall back to the admin's public URL from the
  // env (dev: the admin's localhost port). On the client, the
  // page's own origin wins, so no env var needs to stay in sync — and
  // the fallback matches the page's origin, so SSR and the client
  // render the same URL (no hydration mismatch).
  if (typeof window === "undefined") {
    const base = (
      process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:3006"
    ).replace(/\/$/, "")
    return `${base}/admin`
  }
  return `${window.location.origin}/admin`
}

/** The admin app's own public URL (env-driven, never hardcoded). */
export function adminBaseURL(): string {
  if (typeof window === "undefined") {
    return (
      process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:3006"
    ).replace(/\/$/, "")
  }
  return window.location.origin
}

/** The dashboard app's sign-in page (the admin app has no sign-up page). */
export function dashboardSignInURL(callbackURL?: string): string {
  const base = (
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3002"
  ).replace(/\/$/, "")
  const url = `${base}/sign-in`
  return callbackURL
    ? `${url}?callbackURL=${encodeURIComponent(callbackURL)}`
    : url
}

/** The dashboard app's overview page (for signed-in non-admin users). */
export function dashboardURL(): string {
  const base = (
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3002"
  ).replace(/\/$/, "")
  return `${base}/dashboard`
}
