import path from "path"
import { getListPage } from "@sendcms/content"

// The user docs this app serves. The repo's docs/ dir also holds repo
// docs (architecture.md, the transformation plan, the final report,
// architecture/, archive/) — those are NOT listed here and are never
// served by this app.
export const DOC_SLUGS = [
  "getting-started",
  "sdk",
  "rest-api",
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

function parseDoc(markdown: string): {
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
  // First non-empty, non-heading paragraph after the title.
  const description =
    bodyLines
      .find((line) => {
        const trimmed = line.trim()
        return (
          trimmed.length > 0 &&
          !trimmed.startsWith("#") &&
          !trimmed.startsWith("```")
        )
      })
      ?.trim() ?? ""
  return { title, description, body: bodyLines.join("\n") }
}

export function getDoc(slug: DocSlug): DocEntry {
  const { content } = getListPage(`${slug}.md`, docsDir())
  const { title, description, body } = parseDoc(content)
  return { slug, title, description, body }
}

export function listDocs(): DocEntry[] {
  return DOC_SLUGS.map((slug) => getDoc(slug))
}
