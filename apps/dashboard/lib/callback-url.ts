/**
 * Absolute callback URL for auth flows (`/dashboard` on this app).
 *
 * The auth handler lives in the api app, so its SERVER-side redirects
 * (the email verification link, the OAuth callback) must point back at
 * THIS app by absolute URL — a relative "/dashboard" would resolve on
 * the api app's origin and 404. The forms that pass a callbackURL are
 * client components, so the page's own origin is the dashboard app's
 * URL (dev: http://localhost:3002; production: the dashboard's public
 * URL) — no env var to keep in sync.
 */
export function dashboardCallbackURL(): string {
  // Client components render on the server too (SSR), where `window`
  // does not exist — fall back to the dashboard's public URL from the
  // env (dev: the dashboard's localhost port). On the client, the
  // page's own origin wins, so no env var needs to stay in sync — and
  // the fallback matches the page's origin, so SSR and the client
  // render the same URL (no hydration mismatch).
  if (typeof window === "undefined") {
    const base = (
      process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3002"
    ).replace(/\/$/, "")
    return `${base}/dashboard`
  }
  return `${window.location.origin}/dashboard`
}
