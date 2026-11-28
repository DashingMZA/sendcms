// Phase 17 findings fix — DOC-055 (P3) + DOC-060 (P4): the env recount
// and the repository-inventory §9 env tables must match the code.
//
//   - DOC-055: `WORKER_POLL_TIMEOUT_MS` is read by the email worker via
//     `envInt("…")` (services/email-worker/src/worker.ts:119, default
//     300_000) and must be listed in `.env.example` and the operator
//     docs; the recount script must match `envInt("…")` reads, or the
//     var shows up as "listed NOT referenced" (it is listed, but a
//     script blind to `envInt` never sees the read).
//   - DOC-060: `repository-inventory.md` §9 is regenerated from the
//     recount script (with the DOC-055 `envInt` fix): 67 listed =
//     67 referenced, 0 gap both directions; no dead
//     `STRIPE_PUBLISHABLE_KEY`; the 8 vars Wave 12 omitted are present;
//     the §9 header no longer contradicts itself on §9.2.
import { execSync } from "node:child_process"
import { readFileSync } from "fs"
import { join, resolve } from "path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "..")
const read = (rel: string) => readFileSync(join(root, rel), "utf8")

const runRecount = () =>
  execSync("python3 scripts/env-recount.py", { cwd: root, encoding: "utf8" })

const parseCount = (out: string, label: string) => {
  const m = out.match(new RegExp(`^${label}:\\s*(\\d+)`, "m"))
  expect(m, `recount output has a "${label}" line`).not.toBeNull()
  return Number(m![1])
}

const parseList = (out: string, label: string) => {
  const m = out.match(new RegExp(`^${label}:\\s*(\\[.*\\])`, "m"))
  expect(m, `recount output has a "${label}" line`).not.toBeNull()
  return JSON.parse(m![1].replace(/'/g, '"')) as string[]
}

const listedInEnvExample = () => {
  const names = new Set<string>()
  for (const line of read(".env.example").split("\n")) {
    const m = line.match(/^#?\s*([A-Z][A-Z0-9_]*)\s*=/)
    if (m) names.add(m[1])
  }
  return names
}

const section91 = () => {
  const inv = read("docs/production-readiness/repository-inventory.md")
  const start = inv.indexOf("## 9. Environment variables")
  const end = inv.indexOf("### 9.2", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return inv.slice(start, end)
}

describe("Phase 17 findings fix — DOC-055/DOC-060 env recount + inventory §9", () => {
  // Parent repair 2026-11-28: the recount scans the whole tree (~3.8s
  // alone) and timed out at the 5s default under full-suite load —
  // same flaky class as the ai-rate-limit burst test. 30s matches the
  // step-up.test.ts convention for slow tests. (Vitest 5 takes options
  // as the SECOND argument — (name, fn, {...}) was removed in Vitest 4.)
  it(
    "recount (with envInt reads) is 67 listed = 67 referenced, 0 gap both directions",
    { timeout: 30_000 },
    () => {
      const out = runRecount()
      expect(parseCount(out, "listed in .env.example")).toBe(67)
      expect(
        parseCount(out, "referenced \\(app vars, after exclusions\\)")
      ).toBe(67)
      expect(parseList(out, "referenced NOT listed")).toEqual([])
      // Empty here proves the script sees the envInt read: a script blind
      // to envInt would list WORKER_POLL_TIMEOUT_MS as listed-not-referenced.
      expect(parseList(out, "listed NOT referenced")).toEqual([])
    }
  )

  it("recount script matches envInt reads (DOC-055 root cause)", () => {
    const script = read("scripts/env-recount.py")
    expect(script).toContain("envInt")
    expect(read("services/email-worker/src/worker.ts")).toContain(
      'envInt("WORKER_POLL_TIMEOUT_MS", 300_000)'
    )
  })

  it("WORKER_POLL_TIMEOUT_MS is documented everywhere (DOC-055)", () => {
    expect(read(".env.example")).toContain("# WORKER_POLL_TIMEOUT_MS=300000")
    for (const doc of [
      "docs/deployment.md",
      "docs/operations/runbook.md",
      "docs/email-notifications.md",
    ]) {
      expect(read(doc)).toContain("WORKER_POLL_TIMEOUT_MS")
    }
    expect(read("docs/deployment.md")).toContain("default 300000")
    expect(read("docs/email-notifications.md")).toContain("300_000")
  })

  it("inventory §9.1 lists exactly the .env.example names (DOC-060)", () => {
    const table = section91()
    const names = new Set(
      table.match(/`([A-Z][A-Z0-9_]*)`/g)!.map((s) => s.slice(1, -1))
    )
    expect(names).toEqual(listedInEnvExample())
    expect(names.size).toBe(67)
    // The 8 vars Wave 12 omitted, plus the DOC-055 var.
    for (const name of [
      "CRON_HEARTBEAT_URL",
      "FREEMIUS_SANDBOX",
      "PORT",
      "RESEND_VERIFIED_DOMAINS",
      "RESEND_WEBHOOK_SECRET",
      "SENDCMS_DEV_LOG_EMAIL_TOKENS",
      "STRIPE_MODE",
      "TRUSTED_PROXY_IPS",
      "WORKER_POLL_TIMEOUT_MS",
    ]) {
      expect(names.has(name)).toBe(true)
    }
    // Dead since BIL-020: no code reads it, not in .env.example.
    expect(names.has("STRIPE_PUBLISHABLE_KEY")).toBe(false)
    expect(table).toContain("67 names (26 active + 41 commented)")
  })

  it("inventory §9.2/§9.3 record the post-fix 67/67/0 counts (DOC-060)", () => {
    const inv = read("docs/production-readiness/repository-inventory.md")
    expect(inv).toContain(
      "### 9.2 Every var referenced in code — 67 distinct names"
    )
    expect(inv).toContain("67 listed = 67 referenced, 0 gap both directions")
    expect(inv).toContain(
      "Everything in `.env.example` (67 of 67) is referenced in code"
    )
    expect(inv).toContain(
      "Referenced in code but NOT in `.env.example` (0 app vars)"
    )
    // The three envInt-only worker vars are in the dynamic-access bullet.
    for (const name of ["PORT", "WORKER_PORT", "WORKER_POLL_TIMEOUT_MS"]) {
      expect(inv).toContain(`\`${name}\``)
    }
  })

  it("inventory §9 header no longer contradicts itself on §9.2 (DOC-060)", () => {
    const inv = read("docs/production-readiness/repository-inventory.md")
    const header = inv.slice(0, inv.indexOf("## 1."))
    expect(header).not.toContain("§9.2 per-category breakdown")
    expect(header).toContain("§9 regenerated 2026-11-28")
    // Padding-insensitive: prettier re-pads table columns.
    const flatInv = inv.replace(/[ \t]+/g, " ")
    expect(flatInv).toContain(
      "| Env var names in `.env.example` | 67 (26 active + 41 commented) |"
    )
    expect(flatInv).toContain("| Env var names referenced in code | 67 |")
  })
})
