import type { MetadataRoute } from "next"
import { getBaseUrl } from "@/lib/utils"
import { lastModifiedForMarketingPage } from "@/lib/sitemap-lastmod"

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = getBaseUrl()

  // Only this app's own URLs. /changelog lives in the updates app and
  // the docs live in the docs app — each has its own sitemap.
  // lastmod is per-URL from the page's source-file mtime (PRF-038),
  // not one shared build time.
  const routes: {
    path: string
    changeFrequency: "weekly" | "monthly" | "yearly"
    priority: number
  }[] = [
    { path: "", changeFrequency: "weekly", priority: 1 },
    { path: "/features", changeFrequency: "weekly", priority: 0.8 },
    { path: "/pricing", changeFrequency: "weekly", priority: 0.8 },
    { path: "/contact", changeFrequency: "monthly", priority: 0.7 },
    { path: "/demo/contact-us", changeFrequency: "monthly", priority: 0.6 },
    { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
    { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
  ]
  return routes.map(({ path, changeFrequency, priority }) => ({
    url: `${baseUrl}${path}`,
    lastModified: lastModifiedForMarketingPage(path === "" ? "/" : path),
    changeFrequency,
    priority,
  }))
}
