// Production URL fallback for canonical SEO metadata (sitemap, robots).
// The docs app's production URL is decided in Phase 10 (deployment);
// until then this falls back to the same placeholder as the marketing
// app. When the per-app production URLs are decided, change it here.
import type { Metadata } from "next"
import config from "@/config/config.json"

const FALLBACK_APP_URL = "https://jadoo.bond"

// Absolute, trailing-slash-free base URL for canonical SEO metadata.
// Falls back to the production URL when NEXT_PUBLIC_DOCS_URL is unset.
export function getBaseUrl() {
  return (process.env.NEXT_PUBLIC_DOCS_URL ?? FALLBACK_APP_URL).replace(
    /\/$/,
    ""
  )
}

// PRF-032 (Wave 11, Stream C): a page's `openGraph` REPLACES the
// layout's `openGraph` wholesale — Next.js does not merge the two — so
// any page that sets its own og:url/type must repeat the shared fields
// or they vanish from the rendered <head> (live-verified 2026-11-27:
// doc pages rendered with no og:image). Use this helper for every
// per-page openGraph so the shared fields always survive; the layout's
// openGraph stays as the fallback for pages that set none.
export function pageOpenGraph(
  url: string,
  type: "website" | "article" = "website"
): NonNullable<Metadata["openGraph"]> {
  const baseUrl = getBaseUrl()
  return {
    url,
    type,
    siteName: "SendCMS",
    locale: "en_US",
    images: [
      {
        url: `${baseUrl}${config.metadata.meta_image}`,
        width: 1200,
        height: 630,
        alt: "SendCMS — a contact-form backend for static and modern websites",
      },
    ],
  }
}
