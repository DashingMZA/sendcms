import type { MetadataRoute } from "next"
import { getBaseUrl } from "@/lib/utils"

export default function robots(): MetadataRoute.Robots {
  const baseUrl = getBaseUrl()

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // This app serves only the public changelog page.
    },
    sitemap: `${baseUrl}/sitemap.xml`,
    host: baseUrl,
  }
}
