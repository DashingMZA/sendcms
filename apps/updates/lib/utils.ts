// Production URL fallback for canonical SEO metadata (sitemap, robots).
// The updates app's production URL is decided in Phase 10 (deployment);
// until then this falls back to the same placeholder as the marketing
// app. When the per-app production URLs are decided, change it here.
const FALLBACK_APP_URL = "https://jadoo.bond"

// Absolute, trailing-slash-free base URL for canonical SEO metadata.
// Falls back to the production URL when NEXT_PUBLIC_UPDATES_URL is unset.
export function getBaseUrl() {
  return (process.env.NEXT_PUBLIC_UPDATES_URL ?? FALLBACK_APP_URL).replace(
    /\/$/,
    ""
  )
}
