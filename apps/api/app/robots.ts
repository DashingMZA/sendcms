import type { MetadataRoute } from "next"

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      // The api app serves route handlers, not pages — nothing here
      // is for crawlers (Phase 16, PRF-034). Defence in depth
      // alongside the root-layout `robots: { index: false }` metadata
      // and the `X-Robots-Tag` header in next.config.mjs.
      disallow: "/",
    },
  }
}
