import type { MetadataRoute } from "next"

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      // This is an authenticated app (admin control plane) — nothing
      // here is for crawlers (Phase 16, PRF-034). Defence in depth
      // alongside the root-layout `robots: { index: false }` metadata
      // and the `X-Robots-Tag` header in next.config.mjs.
      disallow: "/",
    },
  }
}
