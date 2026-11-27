import type { MetadataRoute } from "next"
import { getBaseUrl } from "@/lib/utils"

export default function robots(): MetadataRoute.Robots {
  const baseUrl = getBaseUrl()

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // This app serves only the public documentation pages.
    },
    sitemap: `${baseUrl}/sitemap.xml`,
    // PRF-039 (Wave 11): `Host` takes a bare hostname, not a URL.
    // Google ignores the directive; it is kept for Yandex, which reads it.
    host: new URL(baseUrl).hostname,
  }
}
