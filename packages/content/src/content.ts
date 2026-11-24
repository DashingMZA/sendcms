import fs from "fs"
import path from "path"
import matter from "gray-matter"

// Markdown content loader — shared by the marketing, updates, and docs
// apps (each renders markdown from its own content directory).
// `contentDir` defaults to `<cwd>/content` (the calling app's own
// content/ dir); the docs app passes the repo's docs/ dir instead, so
// the GitHub docs stay the single source of truth.
export function getListPage(filePath: string, contentDir?: string) {
  const base = fs.realpathSync(
    path.resolve(contentDir ?? path.join(process.cwd(), "content"))
  )
  // Containment: reject absolute paths and anything that escapes the
  // content dir (`../`), so a caller-supplied slug can never read
  // arbitrary files. realpath resolves symlinks, so a symlink inside
  // the content dir cannot smuggle a read outside it either.
  if (path.isAbsolute(filePath)) {
    throw new Error(`Refusing absolute content path: ${filePath}`)
  }
  const fullPath = path.resolve(base, filePath)
  if (fullPath !== base && !fullPath.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Content path escapes the content directory: ${filePath}`)
  }
  // Resolve symlinks too, so a symlink inside the content dir cannot
  // smuggle a read outside it.
  const realFullPath = fs.realpathSync(fullPath)
  if (realFullPath !== base && !realFullPath.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Content path escapes the content directory: ${filePath}`)
  }
  const raw = fs.readFileSync(realFullPath, "utf-8")
  const { content, data: frontmatter } = matter(raw)
  return { frontmatter, content }
}
