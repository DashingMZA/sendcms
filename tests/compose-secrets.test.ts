/**
 * Phase 16, LVE-016 + LVE-023 — the compose stack never runs on
 * well-known dev-default secrets, and Postgres is never exposed on
 * the host network. Static guard: `docker compose config` with no
 * `.env` must error (the `${VAR:?message}` interpolation), which
 * needs Docker to prove live — this test pins the file shape that
 * makes that true.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const compose = readFileSync("docker-compose.yml", "utf8")

describe("docker-compose secrets (LVE-016)", () => {
  it("ships no dev-default secret values", () => {
    expect(compose).not.toContain("dev-only-secret-change-me")
    expect(compose).not.toContain("dev-only-cron-secret-change-me")
    expect(compose).not.toContain("POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-")
    // The old DATABASE_URL default embedded the well-known Postgres
    // password — it must not survive in any form.
    expect(compose).not.toContain("sendcms:sendcms@")
  })

  it("requires every secret — compose fails fast without a .env", () => {
    for (const name of [
      "DATABASE_URL",
      "BETTER_AUTH_SECRET",
      "CRON_SECRET",
      "POSTGRES_PASSWORD",
    ]) {
      expect(compose).toContain(`${name}: \${${name}:?`)
    }
  })
})

describe("docker-compose Postgres port (LVE-023)", () => {
  it("binds Postgres to localhost only, never the host network", () => {
    expect(compose).toContain('"127.0.0.1:5432:5432"')
    expect(compose).not.toMatch(/^\s+- "5432:5432"$/m)
  })
})
