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

// Validates a `?callbackURL=` from the sign-in page and returns the
// absolute URL to land on after sign-in (Phase 16, Wave 2 — SRC-116).
// The dashboard proxy appends the deep link the user asked for
// (`/dashboard/inbox/<id>`), and the admin proxy appends an absolute
// admin URL; both must survive sign-in, and nothing else may: a
// relative path is made absolute against this app's origin, an
// absolute URL is accepted only on the dashboard or admin origin,
// and anything else (protocol-relative, foreign host, backslashes)
// falls back to /dashboard. Never an open redirect.
export function resolveSignInCallbackURL(raw?: string | null): string {
  const fallback = dashboardCallbackURL()
  if (!raw) return fallback
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) {
    const base =
      typeof window === "undefined"
        ? (
            process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3002"
          ).replace(/\/$/, "")
        : window.location.origin
    return `${base}${raw}`
  }
  try {
    const url = new URL(raw)
    const allowedOrigins = [
      (
        process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3002"
      ).replace(/\/$/, ""),
      (process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:3006").replace(
        /\/$/,
        ""
      ),
    ]
    if (allowedOrigins.includes(url.origin)) return raw
  } catch {
    // Not a parseable absolute URL — fall through to the fallback.
  }
  return fallback
}
