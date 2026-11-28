import { slug } from "github-slugger"
import { marked } from "marked"

// Sanitise marked output at the token level, before anything reaches
// `dangerouslySetInnerHTML` (SEC-208 / SRC-317): raw HTML in the source
// is dropped, and link/image targets are restricted to safe schemes, so
// no attacker-controlled markup or `javascript:` href can survive.
// Served content needs none of this — every raw-HTML fragment in the
// docs and marketing copy lives inside fenced code blocks (rendered as
// escaped code) — so dropping raw HTML changes no rendered page.
const SAFE_LINK_SCHEMES = ["http:", "https:", "mailto:", "tel:"]

function isSafeHref(href: string): boolean {
  const value = href.trim()
  if (
    value === "" ||
    value.startsWith("#") ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../")
  ) {
    return true
  }
  try {
    const scheme = new URL(value, "https://invalid.local").protocol
    return SAFE_LINK_SCHEMES.includes(scheme)
  } catch {
    return false
  }
}

marked.use({
  walkTokens(token) {
    if (token.type === "html") {
      token.text = ""
    } else if (token.type === "link") {
      if (!isSafeHref(token.href)) {
        token.href = "#"
      } else {
        // LVE-003: rewrite relative `.md` links (see below).
        token.href = rewriteDocLink(token.href) ?? token.href
      }
    } else if (token.type === "image" && !isSafeHref(token.href)) {
      token.href = ""
    }
  },
})

// LVE-003 (Phase 16, Wave 12): the docs app renders repo Markdown
// verbatim, so a relative `.md` link in a doc passed through as a
// real anchor pointing at a `.md` URL that 404s (`/docs/sdk.md`)
// while the extensionless sibling (`/docs/sdk`) returns 200 — 19 of
// the 35 unique links on the live docs/updates pages were dead.
// Rewrite relative `.md` hrefs at render time:
// - a flat `<slug>.md` the docs app serves → `/docs/<slug>`;
// - anything else (`deployment/platforms.md`, `operations/runbook.md`,
//   `admin-control-plane/*.md`, `architecture.md`) has no live docs
//   page, so link to its source on GitHub (live branch) instead of
//   to a 404.
// Anchors (`#…`) and query strings survive the rewrite. Absolute
// URLs, `mailto:`/`tel:`, and `#` anchors are never touched.
// The served-slug list mirrors `DOC_SLUGS` in
// `apps/docs/lib/docs.ts` — keep the two in sync when a doc is added
// or removed; a slug missing here falls through to the GitHub link.
const SERVED_DOC_SLUGS = [
  "getting-started",
  "sdk",
  "rest-api",
  "mcp",
  "billing",
  "ai-byok",
  "support-tickets",
  "analytics",
  "embed-html",
  "embed-nextjs",
  "embed-astro",
  "embed-hugo",
  "embed-wordpress",
  "email-notifications",
  "security",
  "troubleshooting",
  "deployment",
] as const

const GITHUB_DOCS_BASE =
  "https://github.com/DashingMZA/sendcms/blob/feature/admin-control-plane/docs"

function rewriteDocLink(href: string): string | null {
  const match = href.match(/^([^#?]*\.md)([#?].*)?$/)
  if (!match) return null
  const [, path, suffix = ""] = match
  // Absolute URLs (any scheme) are never rewritten, even if they end
  // in `.md`.
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null
  // Normalise: strip leading `./`, `../`, `/`, and a `docs/` prefix —
  // the links in the served docs are written relative to the docs/
  // root, so `sdk.md`, `./sdk.md`, and `docs/sdk.md` all mean the
  // same file.
  const normalized = path
    .replace(/^(?:\.\.\/|\.\/|\/)+/, "")
    .replace(/^docs\//, "")
  const withoutExt = normalized.slice(0, -".md".length)
  const isServedSlug =
    !withoutExt.includes("/") &&
    (SERVED_DOC_SLUGS as readonly string[]).includes(withoutExt)
  if (isServedSlug) {
    return `/docs/${withoutExt}${suffix}`
  }
  if (withoutExt.length === 0) return null
  return `${GITHUB_DOCS_BASE}/${normalized}${suffix}`
}

// slugify
export const slugify = (content: string) => {
  return slug(content)
}

// markdownify
export const markdownify = (content: string, div?: boolean) => {
  const markdownContent = div
    ? (marked.parse(content) as string)
    : (marked.parseInline(content) as string)
  return { __html: markdownContent }
}

// humanize
export const humanize = (content: string) => {
  return content
    .replace(/^[\s_]+|[\s_]+$/g, "")
    .replace(/[_\s]+/g, " ")
    .replace(/^[a-z]/, (m) => m.toUpperCase())
}

// titleify
export const titleify = (content: string) => {
  const humanized = humanize(content)
  return humanized
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

// plainify
export const plainify = (content: string) => {
  const parsedMarkdown = marked.parse(content) as string
  const filterBrackets = parsedMarkdown.replace(/<\/?[^>]+(>|$)/gm, "")
  const filterSpaces = filterBrackets.replace(/[\r\n]\s*[\r\n]/gm, "")
  return decodeHtmlEntities(filterSpaces)
}

// strip entities for plainify
const htmlEntities: Record<string, string> = {
  "&nbsp;": " ",
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
}

const decodeHtmlEntities = (htmlWithEntities: string): string => {
  return htmlWithEntities.replace(
    /(&amp;|&lt;|&gt;|&quot;|&#39;)/g,
    (entity: string): string => htmlEntities[entity]
  )
}
