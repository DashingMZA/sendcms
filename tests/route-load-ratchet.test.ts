// TST-003 (Phase 16, Wave 12): route-load ratchet. The suite loaded
// 47 of 157 API routes directly before this wave; the Wave 12 smoke
// tests add 5 more (health, health/deep, csp-report, unsubscribe,
// announcements/active), so the floor is 52. A new route without a
// test, or a deleted route test, drops the count below the floor and
// fails here — raise the floor when new route tests land.
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "..")
const FLOOR = 52

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue
      yield* walk(join(dir, entry.name))
    } else if (entry.isFile() && entry.name === "route.ts") {
      yield join(dir, entry.name)
    }
  }
}

describe("TST-003 — route-load ratchet", () => {
  it(`directly loads at least ${FLOOR} API routes`, () => {
    const routes = [...walk(join(ROOT, "apps/api/app/api"))].map((f) =>
      relative(join(ROOT, "apps/api/app/api"), f)
    )
    const covered = new Set<string>()
    for (const file of readdirSync(join(ROOT, "tests"))) {
      if (!file.endsWith(".test.ts")) continue
      const text = readFileSync(join(ROOT, "tests", file), "utf8")
      for (const match of text.matchAll(
        /from\s*["']\.\.\/apps\/api\/app\/api\/([^"']+?)["']/g
      )) {
        const rel = match[1].replace(/\/route$/, "/route.ts")
        if (routes.includes(rel)) covered.add(rel)
      }
    }
    const share = ((covered.size / routes.length) * 100).toFixed(1)
    expect(
      covered.size,
      `${covered.size}/${routes.length} routes loaded (${share}%) — floor is ${FLOOR}. ` +
        `Uncovered (first 20): ${routes
          .filter((r) => !covered.has(r))
          .slice(0, 20)
          .join(", ")}`
    ).toBeGreaterThanOrEqual(FLOOR)
  })
})
