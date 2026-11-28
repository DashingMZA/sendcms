// DOC-024 (Phase 16, Wave 12): the pure CSP helpers live in their own
// subpath entry (`@sendcms/security/csp`), not in the `@sendcms/security`
// barrel. The barrel also re-exports the db-backed audit writer, rate
// limiter, and step-up helpers (which import `@sendcms/database` and
// `node:fs`), so a proxy importing through the barrel pulls those into
// its import graph. The proxies and the platform-ops health check must
// import the CSP helpers from the subpath only.
//
// This is hygiene, not a build fix: the build never failed on the barrel
// import (the `readFileSync` traces are Turbopack warnings, and a cold
// `build:server` passes). Do not rename these tests to claim otherwise.
import { existsSync, readFileSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

import {
  buildCsp,
  createCspNonce,
  cspHeaderName,
  CSP_HEADER_NAME,
  CSP_REPORT_ONLY,
  CSP_REPORT_ONLY_HEADER_NAME,
} from "@sendcms/security/csp"

const ROOT = join(import.meta.dirname, "..")

const PROXY_FILES = [
  "apps/admin/proxy.ts",
  "apps/api/proxy.ts",
  "apps/dashboard/proxy.ts",
  "apps/docs/proxy.ts",
  "apps/marketing/proxy.ts",
  "apps/updates/proxy.ts",
]

// The four CSP helpers every proxy uses.
const PROXY_CSP_IMPORTS = [
  "buildCsp",
  "createCspNonce",
  "cspHeaderName",
  "CSP_REPORT_ONLY",
]

const HEALTH_FILE = "packages/modules/platform-ops/src/health.ts"
const CSP_FILE = "packages/security/src/csp.ts"
const BARREL_FILE = "packages/security/src/index.ts"
const SECURITY_PKG = "packages/security/package.json"

// Matches `from "@sendcms/..."` (and dynamic import / require forms).
const IMPORT_SPEC_RE =
  /(?:from\s*["']|import\(\s*["']|require\(\s*["'])(@sendcms\/[a-z0-9-]+(?:\/[^"']*)?)["']/g
// Matches `import { a, b } from "..."` / `export { a } from "..."`.
const IMPORT_BINDINGS_RE =
  /(?:import|export)\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g
// Matches every `from "..."` specifier (any package, relative or builtin).
const ANY_IMPORT_RE =
  /(?:import|export)\s+(?:[^'"]*?\s+from\s*)?["']([^"']+)["']/g

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1")
}

function securityImportSpecs(file: string): string[] {
  const text = readFileSync(join(ROOT, file), "utf8")
  return [...text.matchAll(IMPORT_SPEC_RE)]
    .map((m) => m[1] ?? "")
    .filter(
      (spec) =>
        spec === "@sendcms/security" || spec.startsWith("@sendcms/security/")
    )
}

function bindingsFrom(file: string, spec: string): string[] {
  const text = readFileSync(join(ROOT, file), "utf8")
  const found: string[] = []
  for (const match of text.matchAll(IMPORT_BINDINGS_RE)) {
    if (match[2] !== spec) continue
    for (const binding of (match[1] ?? "").split(",")) {
      const name =
        binding
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim() ?? ""
      if (name) found.push(name)
    }
  }
  return found
}

function importSpecs(file: string): string[] {
  const text = readFileSync(join(ROOT, file), "utf8")
  return [...text.matchAll(ANY_IMPORT_RE)]
    .map((m) => m[1] ?? "")
    .filter((spec) => spec !== "vitest")
}

// Resolve an import specifier to a file on disk (or null when it is a
// Node builtin / an external package, which are leaves of the closure).
// Workspace specifiers resolve through the target package's `exports`
// map, mirroring how the bundler and vitest resolve them.
function resolveSpecifier(spec: string, fromFile: string): string | null {
  if (spec.startsWith("node:")) return null
  if (spec.startsWith("@sendcms/")) {
    const parts = spec.split("/")
    const name = parts.slice(0, 2).join("/")
    const subpath = parts.length > 2 ? `./${parts.slice(2).join("/")}` : "."
    const pkgPath = join(ROOT, "node_modules", name, "package.json")
    if (!existsSync(pkgPath)) return null
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      exports?: Record<string, string>
      main?: string
    }
    const target =
      pkg.exports?.[subpath] ?? (subpath === "." ? pkg.main : undefined)
    if (typeof target !== "string") return null
    return resolve(join(ROOT, "node_modules", name), target)
  }
  if (!spec.startsWith(".")) return null
  const base = resolve(dirname(join(ROOT, fromFile)), spec)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.mjs`,
    `${base}.js`,
    join(base, "index.ts"),
    join(base, "index.mjs"),
  ]
  return candidates.find((c) => existsSync(c)) ?? null
}

// The transitive import closure of a file: every local file reachable
// through its imports (builtins and external packages are leaves).
function importClosure(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [join(ROOT, entry)]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const rel = relative(ROOT, file)
    for (const spec of importSpecs(rel)) {
      const resolved = resolveSpecifier(spec, rel)
      if (resolved && extname(resolved) !== ".json") queue.push(resolved)
    }
  }
  return [...seen].sort()
}

describe("DOC-024 — proxies import the CSP helpers from @sendcms/security/csp", () => {
  it("resolves the subpath and exports the full pure CSP set", () => {
    expect(typeof buildCsp).toBe("function")
    expect(typeof createCspNonce).toBe("function")
    expect(typeof cspHeaderName).toBe("function")
    expect(CSP_HEADER_NAME).toBe("Content-Security-Policy")
    expect(CSP_REPORT_ONLY_HEADER_NAME).toBe(
      "Content-Security-Policy-Report-Only"
    )
    expect(typeof CSP_REPORT_ONLY).toBe("boolean")
    expect(buildCsp("n")).toContain("default-src 'self'")
  })

  it("declares the ./csp subpath in the package exports map", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, SECURITY_PKG), "utf8")) as {
      exports?: Record<string, string>
    }
    expect(pkg.exports?.["."]).toBe("./src/index.ts")
    expect(pkg.exports?.["./csp"]).toBe("./src/csp.ts")
  })

  it("the barrel does not re-export the CSP helpers", () => {
    const code = stripComments(readFileSync(join(ROOT, BARREL_FILE), "utf8"))
    expect(code).not.toContain('from "./csp"')
    for (const name of [
      "buildCsp",
      "createCspNonce",
      "cspHeaderName",
      "CSP_HEADER_NAME",
      "CSP_REPORT_ONLY",
      "CSP_REPORT_ONLY_HEADER_NAME",
      "CspOptions",
    ]) {
      expect(code, `${BARREL_FILE} still exports ${name}`).not.toContain(name)
    }
  })

  it("every proxy imports @sendcms/security only through the /csp subpath", () => {
    for (const file of PROXY_FILES) {
      const specs = securityImportSpecs(file)
      expect(
        specs.length,
        `${file} has no @sendcms/security import`
      ).toBeGreaterThan(0)
      for (const spec of specs) {
        expect(
          spec,
          `${file} imports the @sendcms/security barrel — use @sendcms/security/csp`
        ).toBe("@sendcms/security/csp")
      }
      const bindings = bindingsFrom(file, "@sendcms/security/csp")
      for (const name of PROXY_CSP_IMPORTS) {
        expect(
          bindings,
          `${file} does not import ${name} from @sendcms/security/csp`
        ).toContain(name)
      }
    }
  })

  it("platform-ops health imports CSP_REPORT_ONLY from the subpath, not the barrel", () => {
    // health.ts is a module service (it imports db already), so it
    // keeps its barrel import for `readRateLimitConfig` — only the CSP
    // symbol moves to the subpath.
    const specs = securityImportSpecs(HEALTH_FILE)
    expect(specs).toContain("@sendcms/security/csp")
    expect(bindingsFrom(HEALTH_FILE, "@sendcms/security/csp")).toContain(
      "CSP_REPORT_ONLY"
    )
    expect(bindingsFrom(HEALTH_FILE, "@sendcms/security")).not.toContain(
      "CSP_REPORT_ONLY"
    )
  })

  it("the subpath's import closure pulls in no database or filesystem module", () => {
    const closure = importClosure(CSP_FILE)
    expect(closure.map((f) => relative(ROOT, f))).toEqual([CSP_FILE])
    for (const file of closure) {
      const code = readFileSync(file, "utf8")
      const specs = importSpecs(relative(ROOT, file))
      expect(
        specs,
        `${relative(ROOT, file)} imports the database`
      ).not.toContain("@sendcms/database")
      expect(
        specs,
        `${relative(ROOT, file)} imports the filesystem`
      ).not.toContain("node:fs")
      expect(
        specs,
        `${relative(ROOT, file)} imports the filesystem`
      ).not.toContain("node:fs/promises")
      expect(code).not.toContain("readFileSync")
    }
  })
})
