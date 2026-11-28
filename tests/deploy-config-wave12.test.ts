// Deploy-config regression tests (Phase 16, Wave 12):
// SRC-405 (compose TRUSTED_ORIGINS), SRC-406 (render.yaml branch +
// NEXT_PUBLIC_ADMIN_URL), SRC-407 (no jadoo.bond placeholders),
// SRC-414 (no wasted SDK rebuild in non-api builds), SRC-409/TST-009
// (CI runs format:check + i18n validate), TST-019 (PR template lists
// real gates), DB-039 (no stale root prisma.seed pointer).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "..")
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

function serviceBlock(text: string, service: string): string {
  // Split a YAML file into its top-level `  <name>:` blocks and return
  // the named one (compose services and Render services alike).
  const parts = text.split(/^  ([a-z0-9-]+):/m)
  // parts: [prelude, name1, body1, name2, body2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i] === service) return parts[i + 1] ?? ""
  }
  return ""
}

describe("SRC-405 — docker-compose TRUSTED_ORIGINS", () => {
  const compose = read("docker-compose.yml")

  it("the api trusts both the dashboard and the admin origins", () => {
    const api = serviceBlock(compose, "api")
    const match = api.match(/TRUSTED_ORIGINS: \$\{TRUSTED_ORIGINS:-(.+?)\}/)
    expect(match, "api TRUSTED_ORIGINS default").not.toBeNull()
    expect(match?.[1]).toContain("http://localhost:3002")
    expect(match?.[1]).toContain("http://localhost:3006")
  })

  it("each app's own instance trusts its own origin", () => {
    const dashboard = serviceBlock(compose, "dashboard")
    expect(dashboard).toContain("http://localhost:3002")
    const admin = serviceBlock(compose, "admin")
    expect(admin).toContain("http://localhost:3006")
  })
})

describe("SRC-406 — render.yaml", () => {
  const render = read("render.yaml")

  it("pins every service to the current branch", () => {
    const branches = [...render.matchAll(/^    branch: (.+)$/gm)].map(
      (m) => m[1]
    )
    expect(branches.length).toBe(7)
    for (const branch of branches) {
      expect(branch).toBe("feature/admin-control-plane")
    }
    expect(render).not.toContain("feature/monorepo-architecture-migration")
  })

  it("sets NEXT_PUBLIC_ADMIN_URL on all six web services", () => {
    // Split the Blueprint into service blocks on `  - type: <kind>`.
    const blocks = render.split(/^  - type: /m).slice(1)
    const web = blocks.filter((b) => b.startsWith("web\n"))
    expect(web).toHaveLength(6)
    for (const block of web) {
      const name = block.match(/name: (sendcms-[a-z]+)/)?.[1] ?? "?"
      expect(block, `${name} must set NEXT_PUBLIC_ADMIN_URL`).toContain(
        "NEXT_PUBLIC_ADMIN_URL"
      )
      expect(block).toContain("https://sendcms-admin.onrender.com")
    }
  })
})

describe("SRC-407 — no jadoo.bond placeholders", () => {
  it("has zero jadoo.bond occurrences in wranglers and lib/utils.ts", () => {
    const files = [
      ...["api", "dashboard", "docs", "marketing", "updates"].map(
        (app) => `apps/${app}/wrangler.jsonc`
      ),
      "apps/marketing/lib/utils.ts",
      "apps/docs/lib/utils.ts",
      "apps/updates/lib/utils.ts",
    ]
    for (const file of files) {
      expect(read(file), file).not.toContain("jadoo.bond")
    }
  })

  it("uses the decided sendcms.bond hosts in every wrangler", () => {
    for (const app of ["api", "dashboard", "docs", "marketing", "updates"]) {
      const wrangler = read(`apps/${app}/wrangler.jsonc`)
      const hosts = [...wrangler.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map(
        (m) => m[1]
      )
      expect(hosts.length).toBeGreaterThan(0)
      for (const host of hosts) {
        expect(host.endsWith("sendcms.bond")).toBe(true)
      }
    }
  })

  it("falls back to the matching per-app sendcms.bond URL", () => {
    expect(read("apps/marketing/lib/utils.ts")).toContain(
      '"https://sendcms.bond"'
    )
    expect(read("apps/docs/lib/utils.ts")).toContain(
      '"https://docs.sendcms.bond"'
    )
    expect(read("apps/updates/lib/utils.ts")).toContain(
      '"https://updates.sendcms.bond"'
    )
  })
})

describe("SRC-414 — non-api apps do not rebuild the SDK bundle", () => {
  it("has no sdk:build in the five non-api build:cf scripts or wrangler build commands", () => {
    for (const app of ["admin", "dashboard", "docs", "marketing", "updates"]) {
      const pkg = JSON.parse(read(`apps/${app}/package.json`)) as {
        scripts: Record<string, string>
      }
      expect(pkg.scripts["build:cf"], `${app} build:cf`).not.toContain(
        "sdk:build"
      )
      expect(
        read(`apps/${app}/wrangler.jsonc`),
        `${app} wrangler build command`
      ).not.toContain("sdk:build")
    }
    const apiPkg = JSON.parse(read("apps/api/package.json")) as {
      scripts: Record<string, string>
    }
    expect(apiPkg.scripts["build:cf"]).toContain("sdk:build")
  })

  it("has no undeclared JSDoc type import in postcss.config.mjs", () => {
    // The explanatory comment names the package; the undeclared
    // reference itself was the `@type {import('...')}` annotation.
    expect(read("postcss.config.mjs")).not.toContain(
      "import('postcss-load-config')"
    )
  })
})

describe("SRC-409 / TST-009 / TST-012 — CI gates", () => {
  const ci = read(".github/workflows/ci.yml")

  it("runs format:check and i18n validation", () => {
    expect(ci).toContain("pnpm format:check")
    expect(ci).toContain("pnpm validate:i18n")
  })

  it("exercises the Cloudflare build path (build:cf + cf-typegen)", () => {
    expect(ci).toContain("pnpm --filter @sendcms/api build:cf")
    expect(ci).toContain("pnpm cf-typegen")
  })
})

describe("TST-019 — PR template lists real gates", () => {
  const template = read(".github/pull_request_template.md")

  it("cites no phantom commands", () => {
    expect(template).not.toContain("build:api")
    for (const gate of [
      "pnpm typecheck",
      "pnpm lint",
      "pnpm format:check",
      "pnpm validate:i18n",
      "pnpm test",
      "pnpm build",
    ]) {
      expect(template).toContain(gate)
    }
  })
})

describe("DB-039 — no stale root prisma.seed pointer", () => {
  it("has no prisma key in the root package.json", () => {
    const pkg = JSON.parse(read("package.json")) as Record<string, unknown>
    expect("prisma" in pkg).toBe(false)
  })
})
