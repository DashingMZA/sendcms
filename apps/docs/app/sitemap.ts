import type { MetadataRoute } from "next"
import { getBaseUrl } from "@/lib/utils"
import { DOC_SLUGS, getDocLastModified } from "@/lib/docs"

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = getBaseUrl()

  // lastmod is per-URL from the doc source's last commit time (or file
  // mtime when git history is unavailable) — PRF-038. The index lists
  // every doc, so it carries the newest doc's time.
  const docTimes = DOC_SLUGS.map((slug) => getDocLastModified(slug))
  const indexLastModified = new Date(
    Math.max(...docTimes.map((date) => date.getTime()))
  )

  return [
    {
      url: `${baseUrl}/docs`,
      lastModified: indexLastModified,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    ...DOC_SLUGS.map((slug, index) => ({
      url: `${baseUrl}/docs/${slug}`,
      lastModified: docTimes[index],
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ]
}
