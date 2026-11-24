// Static guards for the Wave 2 auth-config findings (LVE-007,
// LVE-008, LVE-022) and the verify-email rejection handling
// (SRC-106). These are file-shape assertions, same pattern as
// compose-secrets.test.ts: the config surfaces are the source of
// truth, so the test pins the shape that makes them correct.
import { readFileSync, readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"

const compose = readFileSync("docker-compose.yml", "utf8")
const envExample = readFileSync(".env.example", "utf8")
const apiWrangler = readFileSync("apps/api/wrangler.jsonc", "utf8")
const dashboardWrangler = readFileSync("apps/dashboard/wrangler.jsonc", "utf8")
const adminWrangler = readFileSync("apps/admin/wrangler.jsonc", "utf8")
const render = readFileSync("render.yaml", "utf8")

// A TRUSTED_ORIGINS value must name both the dashboard origin and
// the admin origin (dev ports 3002 / 3006, or the dashboard. /
// admin. subdomains in production placeholders).
function hasBothOrigins(value: string): boolean {
  const dashboard = value.includes("dashboard") || value.includes("3002")
  const admin = value.includes("admin") || value.includes("3006")
  return dashboard && admin
}

function wranglerVars(source: string): string[] {
  const block = source.match(/"vars":\s*\{([\s\S]*?)\n  \}/)
  if (!block) return []
  return [...block[1].matchAll(/"([A-Z][A-Z0-9_]+)":/g)].map((m) => m[1])
}

function wranglerSecretNames(source: string): string[] {
  const at = source.indexOf("Secrets are NOT stored here")
  if (at === -1) return []
  const comment = source.slice(at)
  return [...comment.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1])
}

describe("TRUSTED_ORIGINS lists dashboard + admin (LVE-007)", () => {
  it("docker-compose defaults include both origins in every service", () => {
    const defaults = [
      ...compose.matchAll(/TRUSTED_ORIGINS: \$\{TRUSTED_ORIGINS:-([^}]+)\}/g),
    ].map((m) => m[1])
    expect(defaults.length).toBeGreaterThan(0)
    for (const value of defaults) expect(hasBothOrigins(value)).toBe(true)
  })

  it(".env.example includes both origins", () => {
    const value = envExample.match(/^TRUSTED_ORIGINS="([^"]*)"/m)?.[1] ?? ""
    expect(hasBothOrigins(value)).toBe(true)
  })

  it("the api wrangler includes both origins", () => {
    const value = apiWrangler.match(/"TRUSTED_ORIGINS":\s*"([^"]*)"/)?.[1] ?? ""
    expect(hasBothOrigins(value)).toBe(true)
  })

  it("the render api service includes both origins", () => {
    const lines = render.split("\n")
    const values: string[] = []
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("key: TRUSTED_ORIGINS")) {
        const value = lines[i + 1]?.match(/value:\s*(.+)/)?.[1] ?? ""
        values.push(value.trim())
      }
    }
    expect(values.length).toBeGreaterThan(0)
    expect(hasBothOrigins(values[0])).toBe(true)
  })
})

describe("dashboard/admin wranglers set the auth vars (LVE-008)", () => {
  it.each([
    ["dashboard", dashboardWrangler],
    ["admin", adminWrangler],
  ])(
    "%s sets BETTER_AUTH_URL, TRUSTED_ORIGINS, NEXT_PUBLIC_APP_URL",
    (_app, source) => {
      const vars = wranglerVars(source)
      for (const name of [
        "BETTER_AUTH_URL",
        "TRUSTED_ORIGINS",
        "NEXT_PUBLIC_APP_URL",
      ]) {
        expect(vars).toContain(name)
      }
      const trusted = source.match(/"TRUSTED_ORIGINS":\s*"([^"]*)"/)?.[1] ?? ""
      expect(hasBothOrigins(trusted)).toBe(true)
    }
  )
})

describe("wrangler vars vs secrets never collide (LVE-022)", () => {
  it("no name appears in both vars and the secrets comment", () => {
    for (const app of readdirSync("apps")) {
      let source: string
      try {
        source = readFileSync(`apps/${app}/wrangler.jsonc`, "utf8")
      } catch {
        continue
      }
      const vars = wranglerVars(source)
      const secrets = wranglerSecretNames(source)
      for (const name of vars) expect(secrets).not.toContain(name)
    }
  })
})

describe("verify-email handler handles rejections (SRC-106)", () => {
  const handler = readFileSync(
    "apps/dashboard/app/(auth)/verify-email/verify-email-handler.tsx",
    "utf8"
  )

  it("catches a rejected verifyEmail call instead of staying pending", () => {
    expect(handler).toContain(".catch(")
  })

  it("wraps the resend call in try/catch/finally so the button re-enables", () => {
    expect(handler).toContain("try {")
    expect(handler).toContain("} catch {")
    expect(handler).toContain("} finally {")
  })
})
