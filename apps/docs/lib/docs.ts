import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "path"
import { getListPage } from "@sendcms/content"

// The user docs this app serves. The repo's docs/ dir also holds repo
// docs (architecture.md, the transformation plan, the final report,
// architecture/, archive/) — those are NOT listed here and are never
// served by this app.
// LVE-003: this list is mirrored as SERVED_DOC_SLUGS in
// packages/content/src/text-converter.ts (the `.md` link rewrite) —
// keep the two in sync when a doc is added or removed.
export const DOC_SLUGS = [
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
  "email-notifications",
  "security",
  "troubleshooting",
  "deployment",
] as const

export type DocSlug = (typeof DOC_SLUGS)[number]

export function isDocSlug(slug: string): slug is DocSlug {
  return (DOC_SLUGS as readonly string[]).includes(slug)
}

// The docs live in the repo's docs/ dir (the GitHub docs are the single
// source of truth) — not in this app's own content/ dir.
function docsDir(): string {
  return path.join(process.cwd(), "..", "..", "docs")
}

export type DocEntry = {
  slug: DocSlug
  title: string
  description: string
  // Markdown body with the first H1 heading removed (the page renders
  // its own title heading).
  body: string
}

// Meta descriptions are ~120–160 chars; truncate at a sentence
// boundary so a SERP snippet never ends mid-sentence.
export const MAX_DESCRIPTION_LENGTH = 155

// Strip inline Markdown from a plain-text description: code spans,
// links/images (keep the visible text), bold/italic markers, HTML tags.
export function stripInlineMarkdown(text: string): string {
  return (
    text
      // Code spans first: strip the backticks but keep the inner text,
      // including angle brackets (`<form>` -> "form" — the HTML-tag pass
      // below would otherwise delete the whole tag).
      .replace(/`([^`]*)`/g, (_match, code: string) =>
        code.replace(/[<>]/g, "")
      )
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim()
  )
}

// Shorten to at most `maxLength` chars, preferring a sentence boundary
// inside the slice; otherwise cut at the last word boundary.
export function truncateAtSentence(
  text: string,
  maxLength = MAX_DESCRIPTION_LENGTH
): string {
  if (text.length <= maxLength) return text
  const slice = text.slice(0, maxLength)
  const boundary = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? ")
  )
  if (boundary > 40) return slice.slice(0, boundary + 1)
  const lastSpace = slice.lastIndexOf(" ")
  const cut = lastSpace > 40 ? lastSpace : maxLength
  return `${slice.slice(0, cut).trim()}…`
}

export function parseDoc(markdown: string): {
  title: string
  description: string
  body: string
} {
  const lines = markdown.split("\n")
  const h1Index = lines.findIndex((line) => line.startsWith("# "))
  const title = h1Index >= 0 ? lines[h1Index].slice(2).trim() : "SendCMS docs"
  const bodyLines =
    h1Index >= 0
      ? [...lines.slice(0, h1Index), ...lines.slice(h1Index + 1)]
      : lines
  // First paragraph (PRF-033, Wave 11): consecutive non-empty,
  // non-heading, non-fence lines after the title, joined with spaces.
  // The old code took only the first LINE, so every description was a
  // 65–73 char fragment ending mid-sentence.
  const paragraphLines: string[] = []
  let inFence = false
  for (const line of bodyLines) {
    const trimmed = line.trim()
    if (trimmed.startsWith("```")) {
      inFence = !inFence
      if (paragraphLines.length > 0) break
      continue
    }
    if (inFence) continue
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      if (paragraphLines.length > 0) break
      continue
    }
    paragraphLines.push(trimmed)
  }
  const description = truncateAtSentence(
    stripInlineMarkdown(paragraphLines.join(" "))
  )
  return { title, description, body: bodyLines.join("\n") }
}

export function getDoc(slug: DocSlug): DocEntry {
  const { content, frontmatter } = getListPage(`${slug}.md`, docsDir())
  const { title, description, body } = parseDoc(content)
  // An explicit `description:` frontmatter override wins over the
  // derived first paragraph (PRF-033: the worst cases, e.g. rest-api,
  // whose first paragraph is a placeholder URL, not a description).
  const override =
    typeof frontmatter.description === "string"
      ? frontmatter.description.trim()
      : ""
  return { slug, title, description: override || description, body }
}

// Last-modified time of a doc's source file (PRF-038, Wave 11): the
// last commit time when git history is available, else the file mtime
// at build; `new Date()` only when neither exists (e.g. a deployed
// bundle with no source file on disk).
export function getDocLastModified(slug: DocSlug): Date {
  const file = path.join(docsDir(), `${slug}.md`)
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", file], {
      cwd: path.join(docsDir(), ".."),
      encoding: "utf-8",
      timeout: 5000,
    }).trim()
    if (out) {
      const commitDate = new Date(out)
      if (!Number.isNaN(commitDate.getTime())) return commitDate
    }
  } catch {
    // No git (or no history for this file) — fall through to mtime.
  }
  try {
    return fs.statSync(file).mtime
  } catch {
    return new Date()
  }
}

export function listDocs(): DocEntry[] {
  return DOC_SLUGS.map((slug) => getDoc(slug))
}
