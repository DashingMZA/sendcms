// Cross-app links (SRC-120, Phase 16, Wave 12). Every app runs as its
// own server (dev: a different localhost port; production: its own
// public URL), so links that leave an app must be absolute. The
// `NEXT_PUBLIC_*_URL` env vars are the single source of truth — see
// `.env.example`. The fallbacks are the dev ports, so a missing var
// still works locally.
//
// This is the single source: it used to live as four copies
// (`apps/{marketing,dashboard,docs,updates}/lib/app-links.ts`) that
// had already drifted in comments. Each app's `lib/app-links.ts` now
// re-exports from here (docs/updates keep their own tiny copy — see
// their files). Client-safe: only `process.env.NEXT_PUBLIC_*` reads.
function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "")
}

export function apiUrl(): string {
  return stripTrailingSlash(
    process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
  )
}

export function dashboardUrl(): string {
  return stripTrailingSlash(
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3002"
  )
}

export function updatesUrl(): string {
  return stripTrailingSlash(
    process.env.NEXT_PUBLIC_UPDATES_URL ?? "http://localhost:3004"
  )
}

export function docsUrl(): string {
  return stripTrailingSlash(
    process.env.NEXT_PUBLIC_DOCS_URL ?? "http://localhost:3003"
  )
}

export function marketingUrl(): string {
  return stripTrailingSlash(
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
  )
}

export function adminUrl(): string {
  return stripTrailingSlash(
    process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:3006"
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

// Resolve a link from the marketing content (which is written
// app-agnostic, e.g. "/sign-in") to the app that actually serves it.
// Same-page anchors and absolute URLs pass through untouched.
export function resolveLink(link: string): string {
  if (link.startsWith("http") || link.startsWith("#")) return link
  if (link.startsWith("/sign-in") || link.startsWith("/dashboard"))
    return `${dashboardUrl()}${link}`
  if (link.startsWith("/changelog")) return `${updatesUrl()}${link}`
  if (link.startsWith("/docs")) return `${docsUrl()}${link}`
  return link
}
