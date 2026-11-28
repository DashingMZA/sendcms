// SRC-401: mechanical check that every `@sendcms/*` import in a
// workspace member is declared in that member's package.json.
//
// `turbo run typecheck` cannot catch this class of error: the root
// package.json blanket-declares every workspace package in
// devDependencies, so an undeclared `@sendcms/*` import still resolves
// through the root node_modules. This script is the real detector —
// it is chained into the root `typecheck` script.
//
// No allowlist entries: every `@sendcms/*` import in the repo is
// declared in its member's package.json (the Wave 12 SRC-403/404/408
// violations — api -> @sendcms/users, submissions -> @sendcms/security,
// dashboard -> @sendcms/plans/@sendcms/ai, and the five proxies plus
// admin/dashboard type imports -> @sendcms/security/@sendcms/database/
// @sendcms/ai — were all fixed and their entries removed here). A
// violation fails the gate; do not re-add an allowlist entry without
// a finding ID and a wave that owns the fix.
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join, relative, dirname } from "node:path"

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..")

const ALLOWLIST = {}

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

const CODE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"])

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue
      yield* walk(join(dir, entry.name))
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf("."))
      if (CODE_EXT.has(ext)) yield join(dir, entry.name)
    }
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function workspaceMembers() {
  const members = []
  const roots = ["apps", "packages", "packages/modules", "services"]
  for (const root of roots) {
    const dir = join(ROOT, root)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pkgPath = join(dir, entry.name, "package.json")
      if (existsSync(pkgPath)) {
        members.push({
          dir: join(dir, entry.name),
          rel: relative(ROOT, join(dir, entry.name)),
          pkg: readJson(pkgPath),
        })
      }
    }
  }
  // The repo root itself: its tests/ import workspace packages, and
  // those must be declared in the root devDependencies.
  members.push({
    dir: join(ROOT, "tests"),
    rel: "tests",
    pkg: readJson(join(ROOT, "package.json")),
    onlyDir: true,
  })
  return members
}

const IMPORT_RE =
  /(?:from\s+["']|import\(\s*["']|require\(\s*["'])(@sendcms\/[a-z0-9-]+)(?:\/[^"']*)?["']/g

let failures = 0
for (const member of workspaceMembers()) {
  const declared = new Set([
    ...Object.keys(member.pkg.dependencies ?? {}),
    ...Object.keys(member.pkg.devDependencies ?? {}),
    ...Object.keys(member.pkg.peerDependencies ?? {}),
    ...Object.keys(member.pkg.optionalDependencies ?? {}),
  ])
  const selfName = member.pkg.name
  const scanDir = member.onlyDir ? member.dir : member.dir
  if (!existsSync(scanDir)) continue
  const used = new Map()
  for (const file of walk(scanDir)) {
    const text = readFileSync(file, "utf8")
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1]
      if (spec === selfName) continue
      if (!used.has(spec)) used.set(spec, [])
      used.get(spec).push(relative(ROOT, file))
    }
  }
  const allowed = new Set(ALLOWLIST[member.rel] ?? [])
  for (const [spec, files] of used) {
    if (declared.has(spec)) continue
    if (allowed.has(spec)) continue
    failures++
    console.error(
      `UNDECLARED IMPORT: ${member.rel} imports ${spec} (not in package.json)\n  ${files.slice(0, 5).join("\n  ")}${files.length > 5 ? `\n  ... +${files.length - 5} more` : ""}`
    )
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} undeclared @sendcms/* import(s). Add the package to the importing member's package.json (dependencies, not the root devDependencies) or fix the import.`
  )
  process.exit(1)
}
console.log("workspace imports: all @sendcms/* imports are declared.")
