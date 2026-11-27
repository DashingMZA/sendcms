// Phase 16, Wave 4 — Stream B.
//
// SRC-107: there is deliberately no single response envelope. The
// contract is documented in
// .agents/skills/project-guidelines/references/route-creation.md:
// admin v1 routes return bare data (ok/created) or 204 (noContent);
// the public submit returns { ok, id, message, redirectUrl }; every
// error is { error } + status. Migrating ok()/created() to an envelope
// is a breaking change and stays an owner decision — these tests pin
// the documented shapes so a drift is caught, not silently shipped.
//
// SRC-114: the refresh mechanism after a mutation is React Query
// invalidation, not revalidatePath — the docs no longer tell routes to
// call it, and every queries file invalidates.
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  ApiError,
  created,
  handleApiError,
  methodNotAllowed,
  noContent,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

const repoRoot = path.resolve(import.meta.dirname, "..")

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf8")
}

describe("SRC-107 admin shapes: bare data, no envelope", () => {
  it("ok() returns the data bare with status 200", async () => {
    const res = ok({ id: "1", name: "Example" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "1", name: "Example" })
  })

  it("created() returns the data bare with status 201", async () => {
    const res = created({ id: "1" })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: "1" })
  })

  it("noContent() returns 204 with an empty body", async () => {
    const res = noContent()
    expect(res.status).toBe(204)
    expect(await res.text()).toBe("")
  })

  it("no v1 route wraps success data in a { data } envelope", () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name === "route.ts") files.push(full)
      }
    }
    walk(path.join(repoRoot, "apps/api/app/api/v1"))
    expect(files.length).toBeGreaterThan(100)
    const offenders = files.filter((f) =>
      readFileSync(f, "utf8").includes("{ data:")
    )
    expect(offenders).toEqual([])
  })

  it("every error is { error } + status", async () => {
    const res = handleApiError(new ApiError("Not found", 404))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Not found" })
    const unknown = handleApiError(new Error("boom"))
    expect(unknown.status).toBe(500)
    expect(await unknown.json()).toEqual({ error: "Internal server error" })
  })

  it("validation failures are 422 { error }", async () => {
    const res = validationErrorResponse({
      flatten: () => ({
        formErrors: [],
        fieldErrors: { email: ["Email must be valid"] },
      }),
    })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: "Email must be valid" })
  })

  it("wrong-method is a JSON 405 with an Allow header", async () => {
    const res = methodNotAllowed(["POST", "OPTIONS"])
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("POST, OPTIONS")
    expect(await res.json()).toEqual({ error: "Method not allowed" })
  })
})

describe("SRC-107 the contract is documented, not migrated", () => {
  it("route-creation.md documents the public-vs-admin split and the owner decision", () => {
    const doc = read(
      ".agents/skills/project-guidelines/references/route-creation.md"
    )
    expect(doc).toContain("## Response Contract")
    expect(doc).toContain("Bare data via `ok()`")
    expect(doc).toContain("{ ok: true, id, message, redirectUrl }")
    expect(doc).toContain("stays an owner decision")
  })
})

describe("SRC-114 revalidatePath is not the refresh mechanism", () => {
  it("the docs no longer tell routes to call revalidatePath", () => {
    const routeCreation = read(
      ".agents/skills/project-guidelines/references/route-creation.md"
    )
    expect(routeCreation).toContain("Do not add `revalidatePath()`")
    expect(routeCreation).not.toContain(
      'revalidatePath("/dashboard", "layout")'
    )
    const conventions = read(
      ".agents/skills/project-guidelines/references/coding-conventions.md"
    )
    expect(conventions).toContain("Routes do NOT call `revalidatePath()`")
  })

  it("every module queries file invalidates on mutation", () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name === "queries.ts") files.push(full)
      }
    }
    walk(path.join(repoRoot, "packages/modules"))
    expect(files).toHaveLength(13)
    for (const file of files) {
      expect(
        readFileSync(file, "utf8"),
        `${file}: invalidates queries`
      ).toContain("invalidateQueries")
    }
  })
})
