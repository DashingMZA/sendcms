// Public URLs of the sibling apps. Each app runs as its own server
// (dev: a different localhost port; production: its own public URL),
// so links that leave this app must be absolute. The *_URL env vars
// are the single source of truth — see .env.example. The fallbacks are
// the dev ports, so a missing var still works locally. Mirrors
// apps/marketing/lib/app-links.ts.
export function marketingUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(
    /\/$/,
    ""
  )
}

/**
 * Absolute URL of the Terms of Service page, which lives on the
 * marketing app — the dashboard app has no /terms route, so a
 * relative "/terms" link would resolve on the dashboard origin and
 * 404. Used by the sign-in and sign-up pages.
 */
export function marketingTermsURL(): string {
  return `${marketingUrl()}/terms`
}
