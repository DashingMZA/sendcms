// Public URLs of the sibling apps. Each app runs as its own server
// (dev: a different localhost port; production: its own public URL),
// so links that leave this app must be absolute. The *_URL env vars
// are the single source of truth — see .env.example. The fallbacks are
// the dev ports, so a missing var still works locally.
export function apiUrl(): string {
  return (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001").replace(
    /\/$/,
    ""
  )
}

export function dashboardUrl(): string {
  return (
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3002"
  ).replace(/\/$/, "")
}

export function updatesUrl(): string {
  return (
    process.env.NEXT_PUBLIC_UPDATES_URL ?? "http://localhost:3004"
  ).replace(/\/$/, "")
}

export function docsUrl(): string {
  return (process.env.NEXT_PUBLIC_DOCS_URL ?? "http://localhost:3003").replace(
    /\/$/,
    ""
  )
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
