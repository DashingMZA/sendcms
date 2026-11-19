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
  return `${window.location.origin}/dashboard`
}
