// Phase 16, Wave 4 — Stream B.
//
// SRC-108: the 12-line 422 validation block was copy-pasted into 68
// route files. The shared helpers in @sendcms/api-client replace it;
// these tests pin the helpers' message format and the absence of any
// remaining copy in apps/api.
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  invalidDateFilterResponse,
  validationErrorMessage,
  validationErrorResponse,
} from "@sendcms/api-client"

const repoRoot = path.resolve(import.meta.dirname, "..")

// The helpers are structural (they only need `flatten()`), so the
// fixture is a plain object — no zod import needed. Real ZodErrors
// flow through the same helpers in the route tests below and in
// tests/admin-date-filters.test.ts.
function badError() {
  return {
    flatten: () => ({
      formErrors: [] as string[],
      fieldErrors: {
        name: ["Name is required"],
        email: ["Email must be valid"],
      },
    }),
  }
}

describe("validationErrorMessage", () => {
  it("joins field messages with '; '", () => {
    expect(validationErrorMessage(badError())).toBe(
      "Name is required; Email must be valid"
    )
  })

  it("falls back to 'Validation failed' for an empty error", () => {
    expect(
      validationErrorMessage({
        flatten: () => ({ formErrors: [], fieldErrors: {} }),
      })
    ).toBe("Validation failed")
  })
})

describe("validationErrorResponse", () => {
  it("returns 422 with the joined { error } body", async () => {
    const res = validationErrorResponse(badError())
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      error: "Name is required; Email must be valid",
    })
  })
})

describe("invalidDateFilterResponse (SRC-119 / SRC-231)", () => {
  it("returns a 422 naming the bad filter", async () => {
    const res = invalidDateFilterResponse({ from: "not-a-date" })
    expect(res).not.toBeNull()
    expect(res!.status).toBe(422)
    expect(await res!.json()).toEqual({ error: "Invalid from date" })
  })

  it("checks `to` as well as `from`", async () => {
    const res = invalidDateFilterResponse({
      from: "2026-01-01",
      to: "garbage",
    })
    expect(res).not.toBeNull()
    expect(await res!.json()).toEqual({ error: "Invalid to date" })
  })

  it("returns null for valid dates, missing values, and other keys", () => {
    expect(
      invalidDateFilterResponse({
        from: "2026-01-01",
        to: "2026-11-24",
      })
    ).toBeNull()
    expect(invalidDateFilterResponse({})).toBeNull()
    expect(
      invalidDateFilterResponse({ period: "2026-11-05T00:00:00.000Z" }, [
        "period",
      ])
    ).toBeNull()
  })

  it("rejects the usage `period` value exactly as the route parses it", async () => {
    const res = invalidDateFilterResponse(
      { period: "not-a-dateT00:00:00.000Z" },
      ["period"]
    )
    expect(res).not.toBeNull()
    expect(await res!.json()).toEqual({ error: "Invalid period date" })
  })
})

describe("SRC-108 no remaining copies", () => {
  function routeFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...routeFiles(full))
      else if (entry.name === "route.ts") out.push(full)
    }
    return out
  }

  it("zero `parsed.error.flatten()` / `.error.flatten()` in apps/api routes", () => {
    const files = routeFiles(path.join(repoRoot, "apps/api/app/api"))
    expect(files.length).toBeGreaterThan(100)
    const offenders = files.filter((f) =>
      readFileSync(f, "utf8").includes(".error.flatten()")
    )
    expect(offenders).toEqual([])
  })

  it("no route file re-implements the flatten-join block", () => {
    // The 13 routes that answer a failed parse with a custom
    // single-message 422 (e.g. "Unknown provider.", "Invalid meter")
    // never had the flatten block; this pins the block itself, not
    // every use of safeParse.
    const files = routeFiles(path.join(repoRoot, "apps/api/app/api"))
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8")
      return src.includes("flat.formErrors") || src.includes("flat.fieldErrors")
    })
    expect(offenders).toEqual([])
  })
})
