import fs from "fs"
import path from "path"
import matter from "gray-matter"

// Markdown content loader — shared by the marketing, updates, and docs
// apps (each renders markdown from its own content directory).
// `contentDir` defaults to `<cwd>/content` (the calling app's own
// content/ dir); the docs app passes the repo's docs/ dir instead, so
// the GitHub docs stay the single source of truth.
export function getListPage(filePath: string, contentDir?: string) {
  const base = contentDir ?? path.join(process.cwd(), "content")
  const fullPath = path.join(base, filePath)
  const raw = fs.readFileSync(fullPath, "utf-8")
  const { content, data: frontmatter } = matter(raw)
  return { frontmatter, content }
}
