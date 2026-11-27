import fs from "node:fs"
import path from "node:path"

// Sitemap lastmod per URL (PRF-038, Wave 11, Stream C): the mtime of
// the source file that page renders from, not the build time — a
// redeploy with zero content changes must not rewrite every lastmod.
// Pages whose content lives in code use their page.tsx (and, for the
// demo, the client form it renders); content-driven pages use their
// Markdown source. Build-time fallback only when no source exists.
const PAGE_SOURCES: Record<string, string[]> = {
  "/": ["content/homepage.md"],
  "/features": ["app/features/page.tsx"],
  "/pricing": ["app/pricing/page.tsx"],
  "/contact": ["app/contact/page.tsx"],
  "/demo/contact-us": [
    "app/demo/contact-us/page.tsx",
    "app/demo/contact-us/demo-form.tsx",
  ],
  "/terms": ["content/terms.md"],
  "/privacy": ["content/privacy.md"],
}

export function lastModifiedForMarketingPage(route: string): Date {
  const candidates = PAGE_SOURCES[route] ?? []
  let latest = 0
  for (const relative of candidates) {
    try {
      const mtime = fs.statSync(path.join(process.cwd(), relative)).mtimeMs
      if (mtime > latest) latest = mtime
    } catch {
      // Missing source file — ignore it; the fallback below covers it.
    }
  }
  return latest > 0 ? new Date(latest) : new Date()
}
