// Phase 17 findings fix (DOC-056 / DOC-057), 2026-11-28 — pins the
// deployment-doc fixes so the docs cannot drift from the code again
// without a failing test:
//   - DOC-056: the per-project table in docs/deployment.md used the
//     Cloudflare worker names (`sendcms` for api, `sendcms-marketing`
//     for marketing) as Vercel project names. The real Vercel projects
//     are api `sendcms-api` and marketing `sendcms`.
//   - DOC-057: the same table omitted vars the apps actually read
//     (marketing `NEXT_PUBLIC_DOCS_URL`, docs/updates
//     `NEXT_PUBLIC_API_URL`) and the admin row's "plus
//     `NEXT_PUBLIC_ADMIN_URL`" was vacuous — that var is the admin
//     project's own URL, already listed in the dashboard row.
//
// The DOC-057 audit is a coverage check, not an exact-equality check:
// every `NEXT_PUBLIC_*` var an app reads must be named in its row.
// A row may list vars the app does not read (e.g. dashboard lists
// `NEXT_PUBLIC_UPDATES_URL`, which no dashboard source reads yet);
// that over-listing is harmless and is not flagged.
//
// How an app's reads are computed: direct `process.env.NEXT_PUBLIC_*`
// reads in the app's own source (`.ts` / `.tsx` / `.mjs`, excluding
// `node_modules`, `.next`, `.open-next`, and `*.d.ts` type declarations,
// with comments stripped) plus the transitive reads behind the
// `@sendcms/shared` app-links helpers the app actually calls
// (`apiUrl()` reads `NEXT_PUBLIC_API_URL`, and so on — see
// `packages/shared/src/app-links.ts`). Reads behind other imported
// packages (e.g. `NEXT_PUBLIC_AUTH_URL`, read by the auth client in
// `packages/auth/src/client.ts` for the dashboard/admin apps) are out
// of scope for the computed set — the rows already list that var, so
// coverage still holds.
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "..")
const read = (rel: string) => readFileSync(join(root, rel), "utf8")

const APPS = [
  "api",
  "dashboard",
  "admin",
  "marketing",
  "docs",
  "updates",
] as const
type App = (typeof APPS)[number]

// `sendcms` is the marketing project; every other project is
// `sendcms-<app>`. This is the naming the Vercel row of
// docs/deployment/platforms.md and the deployment checklist use.
function appForProject(project: string): App {
  if (project === "sendcms") return "marketing"
  const app = project.replace(/^sendcms-/, "")
  if ((APPS as readonly string[]).includes(app)) return app as App
  throw new Error(`Unknown Vercel project name: ${project}`)
}

// The per-project table in docs/deployment.md: rows are
// `| \`project\` [(app label)] | vars ... |`.
function parseDeploymentTable(): Map<App, { project: string; row: string }> {
  const doc = read("docs/deployment.md")
  const section = doc.slice(doc.indexOf("### Per-project env (Vercel)"))
  const rows = new Map<App, { project: string; row: string }>()
  for (const line of section.split("\n")) {
    if (line.startsWith("Notes:")) break
    const match = line.match(/^\| `([^`]+)`(?: \(([a-z]+)\))?\s+\| (.*) \|$/)
    if (!match) continue
    const [, project, label, vars] = match
    const app = (label ?? appForProject(project)) as App
    rows.set(app, { project, row: vars })
  }
  return rows
}

// The Platform x app matrix in docs/deployment/platforms.md: the Vercel
// row names one project per app column.
function parsePlatformsVercelRow(): Map<App, string> {
  const doc = read("docs/deployment/platforms.md")
  const lines = doc.split("\n")
  const headerIdx = lines.findIndex((line) => line.startsWith("| Platform"))
  const columns = lines[headerIdx]
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean)
    .slice(1)
  const vercel = lines
    .slice(headerIdx)
    .find((line) => line.startsWith("| Vercel"))
  if (!vercel) throw new Error("No Vercel row in platforms.md")
  const cells = vercel
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean)
    .slice(1)
  const projects = new Map<App, string>()
  columns.forEach((app, idx) => {
    const match = cells[idx]?.match(/^project `([^`]+)`$/)
    if (match) projects.set(app as App, match[1])
  })
  return projects
}

// The redeploy table in docs/operations/deployment-checklist.md: one row
// per project, with the app in its `pnpm --filter @sendcms/<app>` build
// command.
function parseChecklistProjects(): Map<App, string> {
  const doc = read("docs/operations/deployment-checklist.md")
  const projects = new Map<App, string>()
  for (const line of doc.split("\n")) {
    const match = line.match(
      /^\| \d+\s+\| `([^`]+)`\s+\| `https:[^`]+`\s+\| `pnpm --filter @sendcms\/([a-z]+) build:server`/
    )
    if (match) projects.set(match[2] as App, match[1])
  }
  return projects
}

// Every `NEXT_PUBLIC_*_URL` var named in the env table of
// docs/deployment.md — the family the api row's "all
// `NEXT_PUBLIC_*_URL` vars" expands to.
function nextPublicUrlFamily(): Set<string> {
  const doc = read("docs/deployment.md")
  const envTable = doc.slice(
    doc.indexOf("## Environment variables"),
    doc.indexOf("### Per-project env (Vercel)")
  )
  const family = new Set<string>()
  for (const token of envTable.matchAll(/`([A-Z0-9_]+)`/g)) {
    if (/^NEXT_PUBLIC_[A-Z0-9_]+_URL$/.test(token[1])) family.add(token[1])
  }
  return family
}

// Resolve one table row to the set of `NEXT_PUBLIC_*` vars it covers:
// named vars, the "all `NEXT_PUBLIC_*_URL` vars" wildcard expanded to
// the family above, and "Same as dashboard" inheriting the dashboard
// row's resolved set.
function resolveRowVars(
  rows: Map<App, { project: string; row: string }>,
  app: App,
  family: Set<string>
): Set<string> {
  const { row } = rows.get(app) as { project: string; row: string }
  const vars = new Set<string>()
  for (const token of row.matchAll(/`([A-Z0-9_*]+)`/g)) {
    if (token[1] === "NEXT_PUBLIC_*_URL") {
      for (const name of family) vars.add(name)
    } else if (/^NEXT_PUBLIC_[A-Z0-9_]+$/.test(token[1])) {
      vars.add(token[1])
    }
  }
  if (/Same as dashboard/.test(row)) {
    for (const name of resolveRowVars(rows, "dashboard", family)) vars.add(name)
  }
  return vars
}

// The app-links helper each app-links call reads
// (packages/shared/src/app-links.ts). `resolveLink` branches on the
// link path, so it can reach the dashboard, updates, and docs URLs.
const HELPER_VARS: Record<string, string[]> = {
  apiUrl: ["NEXT_PUBLIC_API_URL"],
  dashboardUrl: ["NEXT_PUBLIC_DASHBOARD_URL"],
  docsUrl: ["NEXT_PUBLIC_DOCS_URL"],
  updatesUrl: ["NEXT_PUBLIC_UPDATES_URL"],
  marketingUrl: ["NEXT_PUBLIC_APP_URL"],
  adminUrl: ["NEXT_PUBLIC_ADMIN_URL"],
  marketingTermsURL: ["NEXT_PUBLIC_APP_URL"],
  resolveLink: [
    "NEXT_PUBLIC_DASHBOARD_URL",
    "NEXT_PUBLIC_UPDATES_URL",
    "NEXT_PUBLIC_DOCS_URL",
  ],
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n")
}

// Every `NEXT_PUBLIC_*` var an app reads: direct `process.env.*` reads
// in its own source plus the transitive reads behind the app-links
// helpers it calls.
function appReadsNextPublic(app: App): Set<string> {
  const reads = new Set<string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".next" ||
        entry.name === ".open-next"
      )
        continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (
        /\.(ts|tsx|mjs)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        const source = stripComments(readFileSync(path, "utf8"))
        for (const match of source.matchAll(
          /process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g
        )) {
          reads.add(match[1])
        }
        for (const [helper, vars] of Object.entries(HELPER_VARS)) {
          if (new RegExp(`\\b${helper}\\s*\\(`).test(source)) {
            for (const name of vars) reads.add(name)
          }
        }
      }
    }
  }
  walk(join(root, "apps", app))
  return reads
}

describe("deployment.md per-project table (DOC-056 / DOC-057)", () => {
  it("DOC-056: names the real Vercel projects, matching platforms.md and the deployment checklist", () => {
    const table = parseDeploymentTable()
    const platforms = parsePlatformsVercelRow()
    const checklist = parseChecklistProjects()
    expect([...table.keys()].sort()).toEqual([...APPS].sort())
    expect([...platforms.keys()].sort()).toEqual([...APPS].sort())
    expect([...checklist.keys()].sort()).toEqual([...APPS].sort())
    for (const app of APPS) {
      expect(table.get(app)?.project).toBe(platforms.get(app))
      expect(table.get(app)?.project).toBe(checklist.get(app))
    }
    // The two names the finding caught: api is `sendcms-api`, not the
    // Cloudflare worker name `sendcms`; marketing is `sendcms`, not
    // `sendcms-marketing`.
    expect(table.get("api")?.project).toBe("sendcms-api")
    expect(table.get("marketing")?.project).toBe("sendcms")
  })

  it("DOC-056: the per-project table never uses a Cloudflare worker name as a Vercel project", () => {
    const table = parseDeploymentTable()
    // `sendcms-marketing` is a real Cloudflare worker name (see the
    // Cloudflare notes in deployment.md) — it is not a Vercel project.
    expect([...table.values()].map((entry) => entry.project)).not.toContain(
      "sendcms-marketing"
    )
    expect(read("docs/deployment.md")).toContain("sendcms-api")
  })

  it("DOC-057: every row covers the NEXT_PUBLIC_* vars its app reads", () => {
    const table = parseDeploymentTable()
    const family = nextPublicUrlFamily()
    expect(family.size).toBeGreaterThanOrEqual(7)
    for (const app of APPS) {
      const covered = resolveRowVars(table, app, family)
      const reads = appReadsNextPublic(app)
      expect(reads.size).toBeGreaterThan(0)
      const missing = [...reads].filter((name) => !covered.has(name))
      expect(
        missing,
        `${app} row omits vars the app reads: ${missing.join(", ")}`
      ).toEqual([])
    }
  })

  it("DOC-057: the three vars the finding caught are listed, and the admin row adds nothing vacuous", () => {
    const table = parseDeploymentTable()
    const family = nextPublicUrlFamily()
    // Marketing reads NEXT_PUBLIC_DOCS_URL via docsUrl() in
    // apps/marketing/app/page.tsx; docs/updates read NEXT_PUBLIC_API_URL
    // in their proxy.ts CSP report-uri.
    expect(resolveRowVars(table, "marketing", family)).toContain(
      "NEXT_PUBLIC_DOCS_URL"
    )
    expect(resolveRowVars(table, "docs", family)).toContain(
      "NEXT_PUBLIC_API_URL"
    )
    expect(resolveRowVars(table, "updates", family)).toContain(
      "NEXT_PUBLIC_API_URL"
    )
    // NEXT_PUBLIC_ADMIN_URL is the admin project's own public URL, not
    // an extra on top of the dashboard set — the row must not present
    // it as one.
    expect(table.get("admin")?.row).not.toContain(
      "plus `NEXT_PUBLIC_ADMIN_URL`"
    )
  })
})
