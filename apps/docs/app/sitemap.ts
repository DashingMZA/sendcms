import type { MetadataRoute } from "next"
import { getBaseUrl } from "@/lib/utils"
import { DOC_SLUGS } from "@/lib/docs"

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = getBaseUrl()
  const lastModified = new Date()

  return [
    {
      url: `${baseUrl}/docs`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    ...DOC_SLUGS.map((slug) => ({
      url: `${baseUrl}/docs/${slug}`,
      lastModified,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ]
}
