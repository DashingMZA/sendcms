// Production URL fallback for canonical SEO metadata (sitemap, robots,
// JSON-LD). This is the live Cloudflare deployment URL (wrangler vars set
// the same value); when the final production domain is decided, change it
// here and in wrangler.jsonc together.
const FALLBACK_APP_URL = "https://jadoo.bond"

// Absolute, trailing-slash-free base URL for canonical SEO metadata
// (sitemap, robots, JSON-LD). Falls back to the production URL when
// NEXT_PUBLIC_APP_URL is unset.
export function getBaseUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL ?? FALLBACK_APP_URL).replace(
    /\/$/,
    ""
  )
}
