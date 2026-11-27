import type { MetadataRoute } from "next"
import { getBaseUrl } from "@/lib/utils"
import { latestChangelogDate } from "@/lib/changelog"

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = getBaseUrl()

  return [
    {
      url: `${baseUrl}/changelog`,
      // lastmod is the latest entry's date (PRF-038) — see lib/changelog.ts.
      lastModified: latestChangelogDate(),
      changeFrequency: "weekly",
      priority: 0.7,
    },
  ]
}
