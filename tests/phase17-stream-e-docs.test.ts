// Phase 17 findings fix, Stream E — docs-audit pins so the docs
// cannot drift from the code again without a failing test:
//   - DOC-059: deployment-checklist.md §5 records LVE-009 (render.yaml
//     branch pins) and LVE-010 (docs/updates root redirects) as fixed,
//     with the evidence — never again as "decision open".
//   - DOC-061: docs/admin-control-plane/csp.md names the
//     POST /api/csp-report endpoint (purpose, 204, 16 KB cap).
// No test hits the real DB, a real provider, or the network.
import { readFileSync } from "fs"
import { join, resolve } from "path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "..")
const read = (rel: string) => readFileSync(join(root, rel), "utf8")
// Prose assertions run on whitespace-flattened text so a prettier
// re-wrap of a doc never breaks the test.
const flat = (text: string) => text.replace(/\s+/g, " ")

describe("Phase 17 Stream E — deployment checklist matches the code (DOC-059)", () => {
  it("checklist §5 records LVE-009 and LVE-010 as fixed, not 'decision open'", () => {
    const checklist = flat(read("docs/operations/deployment-checklist.md"))
    expect(checklist).not.toContain("LVE-009 (decision open)")
    expect(checklist).not.toContain("LVE-010 (decision open)")
    expect(checklist).toContain(
      "LVE-009 (fixed in the Wave 12 decision follow-ups)"
    )
    expect(checklist).toContain(
      "LVE-010 (fixed in the Wave 12 decision follow-ups)"
    )
    expect(checklist).toContain(
      "pins the live branch `feature/admin-control-plane` on all 7 services"
    )
    expect(checklist).toContain('permanentRedirect("/docs")')
    expect(checklist).toContain('permanentRedirect("/changelog")')
  })

  it("all 7 render.yaml branch pins are feature/admin-control-plane (LVE-009)", () => {
    const render = read("render.yaml")
    const pins = render.match(/^\s*branch: .+$/gm) ?? []
    expect(pins).toHaveLength(7)
    for (const pin of pins) {
      expect(pin.trim()).toBe("branch: feature/admin-control-plane")
    }
  })

  it("the docs/updates bare roots permanent-redirect (308) (LVE-010)", () => {
    const docs = read("apps/docs/app/page.tsx")
    const updates = read("apps/updates/app/page.tsx")
    expect(docs).toContain("permanentRedirect")
    expect(docs).toContain('permanentRedirect("/docs")')
    // The plain redirect() (307) is only ever mentioned in the comment
    // explaining why it was not used — never called.
    expect(docs).not.toMatch(/^\s*redirect\(/m)
    expect(updates).toContain("permanentRedirect")
    expect(updates).toContain('permanentRedirect("/changelog")')
    expect(updates).not.toMatch(/^\s*redirect\(/m)
  })
})

describe("Phase 17 Stream E — CSP report endpoint is documented (DOC-061)", () => {
  it("csp.md names POST /api/csp-report with its purpose, 204, and 16 KB cap", () => {
    const csp = flat(read("docs/admin-control-plane/csp.md"))
    expect(csp).toContain("POST /api/csp-report")
    expect(csp).toContain("apps/api/app/api/csp-report/route.ts")
    expect(csp).toContain("Always 204")
    expect(csp).toContain("16,384 bytes")
    expect(csp).toContain("never requires auth")
    expect(csp).toContain("never touches the database")
  })
})
