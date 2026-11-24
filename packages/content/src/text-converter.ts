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
    } else if (token.type === "link" && !isSafeHref(token.href)) {
      token.href = "#"
    } else if (token.type === "image" && !isSafeHref(token.href)) {
      token.href = ""
    }
  },
})

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
