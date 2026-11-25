// Wave 5 Stream C — static regression tests for the findings whose
// behaviour is proven by the mocked service tests + the live-DB
// suite, but whose wiring lives in locale files, comments, and
// client components (ADM-091, ADM-092 drift guard, ADM-093 hook
// wiring, PRF-013 aggregate shape, PRF-015 take coverage). No test
// here hits the real DB.
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { DeleteFlagSchema } from "@sendcms/platform-ops/validators"

const root = process.cwd()
const read = (rel: string) => readFileSync(path.join(root, rel), "utf-8")

function readJson(rel: string): Record<string, string> {
  return JSON.parse(read(rel)) as Record<string, string>
}

describe("ADM-091 — feature-flag note tells the truth", () => {
  it("names the two wired flags in en + ur, with no stale text", () => {
    for (const locale of ["en", "ur"]) {
      const features = readJson(
        `packages/i18n/locales/${locale}/admin/features.json`
      )
      expect(features.phase8Note).toContain("ai-spam-rescore")
      expect(features.phase8Note).toContain("ai-digest")
    }
    const en = readJson("packages/i18n/locales/en/admin/features.json")
    expect(en.phase8Note).not.toContain("No feature reads a flag yet")
    const ur = readJson("packages/i18n/locales/ur/admin/features.json")
    expect(ur.phase8Note).not.toContain("کوئی فیچر فلیگ نہیں پڑھتا")
    // The two header comments were updated the same way.
    for (const file of [
      "apps/admin/components/admin/features-overview.tsx",
      "packages/modules/platform-ops/src/flags.ts",
    ]) {
      expect(read(file).toLowerCase()).not.toContain(
        "no feature reads a flag yet"
      )
    }
  })

  it("keeps en/ur keys in sync for the new strings", () => {
    const en = readJson("packages/i18n/locales/en/admin/features.json")
    const ur = readJson("packages/i18n/locales/ur/admin/features.json")
    for (const key of [
      "phase8Note",
      "deleteFlag",
      "deleteTitle",
      "deleteDescription",
      "flagDeleted",
      "systemFlag",
    ]) {
      expect(en[key]).toBeDefined()
      expect(ur[key]).toBeDefined()
    }
    const enAnn = readJson("packages/i18n/locales/en/admin/announcements.json")
    const urAnn = readJson("packages/i18n/locales/ur/admin/announcements.json")
    for (const key of [
      "pageOf",
      "prev",
      "next",
      "filterStatus",
      "filterAudience",
      "all",
    ]) {
      expect(enAnn[key]).toBeDefined()
      expect(urAnn[key]).toBeDefined()
    }
  })
})

describe("ADM-092 — system-flag list cannot drift", () => {
  it("the UI's copy matches the service's SYSTEM_FLAGS", () => {
    const flagsSrc = read("packages/modules/platform-ops/src/flags.ts")
    const uiSrc = read("apps/admin/components/admin/features-overview.tsx")
    const serviceKeys = flagsSrc.match(/SYSTEM_FLAGS = \[([^\]]+)\]/)?.[1]
    const uiKeys = uiSrc.match(/SYSTEM_FLAG_KEYS = \[([^\]]+)\]/)?.[1]
    expect(serviceKeys).toBeDefined()
    expect(uiKeys).toBeDefined()
    const parse = (s: string) =>
      s
        .split(",")
        .map((k) => k.trim().replace(/["']/g, ""))
        .filter(Boolean)
        .sort()
    expect(parse(uiKeys as string)).toEqual(parse(serviceKeys as string))
  })

  it("the delete route exists and the reason is required", () => {
    const route = read("apps/api/app/api/v1/admin/features/[key]/route.ts")
    expect(route).toContain("export async function DELETE")
    expect(route).toContain("deleteFlag(")
    expect(DeleteFlagSchema.safeParse({}).success).toBe(false)
    expect(DeleteFlagSchema.safeParse({ reason: "Retired" }).success).toBe(true)
  })
})

describe("ADM-093 — announcements hook + page wiring", () => {
  it("useAnnouncements accepts page/perPage/isActive/audience and queries with them", () => {
    const queries = read("packages/modules/platform-ops/src/queries.ts")
    expect(queries).toContain("export function useAnnouncements(")
    expect(queries).toContain("AnnouncementsFilters")
    expect(queries).toContain("isActive")
    expect(queries).toContain("audience: filters.audience")
    const page = read("apps/admin/components/admin/announcements-overview.tsx")
    expect(page).toContain("useAnnouncements({")
    expect(page).toContain("isActive:")
    expect(page).toContain("audience:")
    expect(page).toContain('t("pageOf"')
    expect(page).toContain('t("prev"')
    expect(page).toContain('t("next"')
  })
})

describe("PRF-013 — overview per-day series is a SQL aggregate", () => {
  it("groups by day in SQL instead of loading every timestamp", () => {
    const overview = read("packages/modules/platform-ops/src/overview.ts")
    expect(overview).toContain("DATE_TRUNC('day'")
    expect(overview).toContain("GROUP BY 1")
    expect(overview).not.toContain(
      "db.submission.findMany({ where: inRange, select: { createdAt: true } })"
    )
  })
})

describe("PRF-015 — every findMany in getUserDetail carries a take", () => {
  it("statically: no uncapped list in the detail function", () => {
    const src = read("packages/modules/admin-users/src/service.ts")
    const start = src.indexOf("export async function getUserDetail(")
    expect(start).toBeGreaterThan(-1)
    // Brace-match the function body.
    let depth = 0
    let end = -1
    for (let i = src.indexOf("{", start); i < src.length; i++) {
      if (src[i] === "{") depth++
      if (src[i] === "}") {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    expect(end).toBeGreaterThan(start)
    const body = src.slice(start, end)
    const calls = [...body.matchAll(/\.findMany\(/g)]
    expect(calls.length).toBeGreaterThanOrEqual(5)
    // Paren-match each findMany call and require a take inside it.
    for (const call of calls) {
      const callStart = (call.index as number) + ".findMany".length
      let parenDepth = 0
      let callEnd = -1
      for (let i = callStart; i < body.length; i++) {
        if (body[i] === "(") parenDepth++
        if (body[i] === ")") {
          parenDepth--
          if (parenDepth === 0) {
            callEnd = i
            break
          }
        }
      }
      expect(callEnd).toBeGreaterThan(callStart)
      expect(body.slice(callStart, callEnd)).toContain("take:")
    }
  })
})
