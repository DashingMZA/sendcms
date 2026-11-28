// SRC-330 (Phase 16, Wave 12): the `db` value from `@sendcms/database`
// may be imported only from module services and the documented
// infrastructure exceptions (see coding-conventions.md). A new direct
// `db` import anywhere else fails here until it is added to the list
// in the docs with a reason.
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "..")

// The documented exceptions: single-purpose infrastructure packages,
// like the rate limiter — routing their DB access through a service
// layer would be a fake abstraction. Keep in sync with
// coding-conventions.md (and AGENTS.md).
const EXCEPTIONS = new Set([
  "apps/api/instrumentation-node.ts",
  "packages/auth/src/auth.ts",
  "packages/mcp/src/access.ts",
  "packages/mcp/src/rate-limit.ts",
  "packages/mcp/src/usage.ts",
  "packages/permissions/src/target-user.ts",
  "packages/queue/src/index.ts",
  "packages/security/src/audit.ts",
  "packages/security/src/rate-limit.ts",
  "packages/security/src/step-up.ts",
])

const SCAN_ROOTS = [
  "apps/admin",
  "apps/api",
  "apps/dashboard",
  "apps/docs",
  "apps/marketing",
  "apps/updates",
  "packages",
  "services",
]

const IGNORE_DIRS = new Set([
  "node_modules",
  ".next",
  ".open-next",
  "generated",
  "dist",
  "coverage",
  "public",
  ".turbo",
])

// Matches `import { …, db, … } from "@sendcms/database"` (multiline too).
// `import type { … }` never binds the value, so it is excluded.
// Plain capture group, no `s` flag: the base tsconfig targets ES2017,
// which has neither named groups nor the dotAll flag — and neither is
// needed here (`[^}]` and `\s` already cross newlines).
const DB_IMPORT_RE = /import\s*\{([^}]*)}\s*from\s*["']@sendcms\/database["']/g

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue
      yield* walk(join(dir, entry.name))
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    ) {
      yield join(dir, entry.name)
    }
  }
}

function importsDbValue(file: string): boolean {
  const text = readFileSync(file, "utf8")
  for (const match of text.matchAll(DB_IMPORT_RE)) {
    // A `type`-only import binds nothing at runtime — but the regex
    // above also matches `import type { … }`, so skip those.
    if (match[0].startsWith("import type")) continue
    const bindings = (match[1] ?? "").split(",").map((b) => b.trim())
    if (bindings.some((b) => b === "db" || b.startsWith("db "))) return true
  }
  return false
}

function isAllowedService(file: string): boolean {
  // Module services only — never queries.ts / validators.ts (client
  // hooks and schemas must stay free of the database).
  if (!file.startsWith("packages/modules/")) return false
  if (!file.includes("/src/")) return false
  const base = file.split("/").pop() ?? ""
  return base !== "queries.ts" && base !== "validators.ts"
}

function findDbImporters(): string[] {
  const found: string[] = []
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      if (importsDbValue(file)) found.push(relative(ROOT, file))
    }
  }
  return found.sort()
}

describe("SRC-330 — direct @sendcms/database (db value) imports", () => {
  it("imports db only from module services, the database package itself, and the documented exceptions", () => {
    const importers = findDbImporters()
    const unlisted = importers.filter((file) => {
      if (file.startsWith("packages/database/src/")) return false
      if (isAllowedService(file)) return false
      return !EXCEPTIONS.has(file)
    })
    expect(
      unlisted,
      `Unlisted direct db importers — add them to the exception list in coding-conventions.md with a reason, or route the access through a module service:\n${unlisted.join("\n")}`
    ).toEqual([])
  })

  it("has no db value import under apps/ (routes and components never touch the database)", () => {
    const importers = findDbImporters()
    // The one documented app exception: the api app's Node-only boot
    // check (instrumentation-node.ts) — not a route, never Edge/client.
    const appImporters = importers.filter(
      (file) =>
        file.startsWith("apps/") && file !== "apps/api/instrumentation-node.ts"
    )
    expect(appImporters).toEqual([])
  })

  it("every listed exception still imports db (no stale entries)", () => {
    const importers = new Set(findDbImporters())
    const stale = [...EXCEPTIONS].filter((file) => !importers.has(file))
    expect(
      stale,
      `Stale exception entries (they no longer import db — remove them from the list):\n${stale.join("\n")}`
    ).toEqual([])
  })
})
