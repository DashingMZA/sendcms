import type { MetadataRoute } from "next"
import { getBaseUrl } from "@/lib/utils"

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = getBaseUrl()
  const lastModified = new Date()

  return [
    {
      url: `${baseUrl}/changelog`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    },
  ]
}
