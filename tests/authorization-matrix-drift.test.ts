// DOC-058 (Phase 17 findings fix, 2026-11-28): the authorization.md
// capability matrix drifted from `packages/permissions/src/platform.ts`
// — the Phase C Jobs capabilities (`VIEW_JOBS` / `MANAGE_JOBS`) were
// missing entirely and all three prose counts were wrong (SUPER_ADMIN
// "25 of 26", MANAGER "12", SUPPORT "5"; actual 27 of 28 / 13 / 6).
// This test parses the doc's tables and prose and compares them against
// the code, so the next capability added to `platform.ts` fails here
// until the doc is regenerated.
//
// NOTE: `ADMIN_CAPABILITIES` is module-private in platform.ts (not
// exported), so the test reads it from the source — the same way the
// other doc-vs-code tests in tests/ read their sources — while the
// per-role grants come from the exported `ADMIN_ROLE_CAPABILITIES`.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ADMIN_ROLE_CAPABILITIES, type AdminRole } from "@sendcms/permissions"

const ROOT = join(import.meta.dirname, "..")
const DOC_PATH = join(ROOT, "docs/admin-control-plane/authorization.md")
const PLATFORM_PATH = join(ROOT, "packages/permissions/src/platform.ts")

const ROLES: AdminRole[] = ["SUPER_ADMIN", "MANAGER", "SUPPORT"]

function section(text: string, start: string, end: string): string {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return text.slice(from, to)
}

// The Capabilities table rows: `| \`CAP\` | Guards... |`
function parseCapabilitiesTable(doc: string): string[] {
  const body = section(doc, "## Capabilities", "## Role matrix")
  return body
    .split("\n")
    .map((line) => line.match(/^\| `([A-Z_]+)`\s*\|/)?.[1])
    .filter((cap): cap is string => cap !== undefined)
}

// The Role matrix rows: `| \`CAP\` | ✓/— | ✓/— | ✓/— |`
function parseRoleMatrix(doc: string): Map<string, boolean[]> {
  const body = section(doc, "## Role matrix", "Notes on the map:")
  const rows = new Map<string, boolean[]>()
  for (const line of body.split("\n")) {
    const match = line.match(
      /^\| `([A-Z_]+)`\s*\|\s*([✓—])\s*\|\s*([✓—])\s*\|\s*([✓—])\s*\|/
    )
    if (match) {
      rows.set(
        match[1],
        match.slice(2).map((cell) => cell === "✓")
      )
    }
  }
  return rows
}

// `ADMIN_CAPABILITIES` is not exported, so read it from the source.
function parseAdminCapabilitiesFromSource(): string[] {
  const src = readFileSync(PLATFORM_PATH, "utf8")
  const match = src.match(/const ADMIN_CAPABILITIES[^=]*=\s*\[([\s\S]*?)\n\]/)
  expect(match).not.toBeNull()
  return [...match![1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1])
}

const doc = readFileSync(DOC_PATH, "utf8")
const adminCapabilities = parseAdminCapabilitiesFromSource()

describe("authorization.md capability matrix drift (DOC-058)", () => {
  it("Capabilities table lists exactly the ADMIN_CAPABILITIES set", () => {
    expect([...parseCapabilitiesTable(doc)].sort()).toEqual(
      [...adminCapabilities].sort()
    )
  })

  it("Role matrix lists exactly the ADMIN_CAPABILITIES set", () => {
    expect([...parseRoleMatrix(doc).keys()].sort()).toEqual(
      [...adminCapabilities].sort()
    )
  })

  it("Role matrix cells match ADMIN_ROLE_CAPABILITIES per role", () => {
    const matrix = parseRoleMatrix(doc)
    for (const cap of adminCapabilities) {
      const cells = matrix.get(cap)
      expect(cells, cap).toBeDefined()
      for (const [index, role] of ROLES.entries()) {
        expect(cells![index], `${cap} for ${role}`).toBe(
          (ADMIN_ROLE_CAPABILITIES[role] as readonly string[]).includes(cap)
        )
      }
    }
  })

  it("Role matrix check counts match the role maps", () => {
    const matrix = parseRoleMatrix(doc)
    for (const [index, role] of ROLES.entries()) {
      const checked = [...matrix.values()].filter(
        (cells) => cells[index]
      ).length
      expect(checked, `${role} ✓ count`).toBe(
        ADMIN_ROLE_CAPABILITIES[role].length
      )
    }
  })

  it("Prose counts match the code (28 total, 27 of 28, 13, 6)", () => {
    const total = adminCapabilities.length
    expect(total).toBe(28)
    expect(doc).toMatch(new RegExp(`${total} admin capabilities`))
    expect(doc).toMatch(new RegExp(`all ${total} \\(plus`))
    const superAdmin = section(doc, "- **SUPER_ADMIN**", "- **MANAGER**")
    const superMatch = superAdmin.match(/(\d+) of (\d+)/)
    expect(superMatch).not.toBeNull()
    expect(Number(superMatch![1])).toBe(
      ADMIN_ROLE_CAPABILITIES.SUPER_ADMIN.length
    )
    expect(Number(superMatch![2])).toBe(total)
    for (const role of ["MANAGER", "SUPPORT"] as const) {
      const note = section(
        doc,
        `- **${role}**`,
        role === "MANAGER" ? "- **SUPPORT**" : "Proven by"
      )
      const countMatch = note.match(/(\d+) capabilities/)
      expect(countMatch, `${role} prose count`).not.toBeNull()
      expect(Number(countMatch![1]), `${role} prose count`).toBe(
        ADMIN_ROLE_CAPABILITIES[role].length
      )
    }
    expect(doc).not.toContain("25 of 26")
    expect(doc).not.toContain("26 admin capabilities")
  })

  it("Jobs capabilities carry the Phase C grants (DOC-058)", () => {
    const matrix = parseRoleMatrix(doc)
    // VIEW_JOBS is all staff (Health-page parity); MANAGE_JOBS is
    // SUPER_ADMIN + owner (requeue, manual cron run).
    expect(matrix.get("VIEW_JOBS")).toEqual([true, true, true])
    expect(matrix.get("MANAGE_JOBS")).toEqual([true, false, false])
    expect(parseCapabilitiesTable(doc)).toContain("VIEW_JOBS")
    expect(parseCapabilitiesTable(doc)).toContain("MANAGE_JOBS")
  })
})
