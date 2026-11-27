import config from "@/config/config.json"
import { getBaseUrl } from "@/lib/utils"

// Schema.org WebSite + Organization JSON-LD for the marketing app
// (PRF-036, Wave 11, Stream C). Same pattern as ProductSchema: a
// server component rendering one <script type="application/ld+json">.
// Rendered from the root layout, so it is present on every marketing
// page; per-page types (Product on `/`, TechArticle on docs,
// BlogPosting on the changelog) live on their own pages.
export function SiteSchema() {
  const baseUrl = getBaseUrl()

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        name: config.site.title,
        url: baseUrl,
        description: config.metadata.meta_description,
      },
      {
        "@type": "Organization",
        name: config.site.title,
        url: baseUrl,
        logo: `${baseUrl}${config.site.logo}`,
      },
    ],
  }

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
    />
  )
}
