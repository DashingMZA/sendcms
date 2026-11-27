import fs from "node:fs"
import path from "node:path"
import { getListPage } from "@sendcms/content"

// Last-modified time for the changelog (PRF-038, Wave 11, Stream C):
// the latest entry's date — the page changes exactly when a new entry
// ships. Falls back to the changelog file's mtime, then to build time.
// Lives here (not in app/sitemap.ts) so it stays unit-testable: the
// sitemap module imports `@/lib/*`, which vitest cannot resolve.
export function latestChangelogDate(): Date {
  try {
    const { frontmatter } = getListPage("changelog.md")
    const entries = (frontmatter.entries ?? []) as { date: string }[]
    const times = entries
      .map((entry) => new Date(entry.date).getTime())
      .filter((time) => !Number.isNaN(time))
    if (times.length > 0) return new Date(Math.max(...times))
  } catch {
    // Unparseable changelog — fall through to the mtime fallback.
  }
  try {
    return fs.statSync(path.join(process.cwd(), "content", "changelog.md"))
      .mtime
  } catch {
    return new Date()
  }
}
