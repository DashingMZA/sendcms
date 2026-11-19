import type { MetadataRoute } from "next"
import { getBaseUrl } from "@/lib/utils"

export default function robots(): MetadataRoute.Robots {
  const baseUrl = getBaseUrl()

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // This app serves only public marketing pages — the dashboard,
      // auth, and API routes live in sibling apps with their own
      // robots files, so there is nothing to disallow here.
    },
    sitemap: `${baseUrl}/sitemap.xml`,
    host: baseUrl,
  }
}
