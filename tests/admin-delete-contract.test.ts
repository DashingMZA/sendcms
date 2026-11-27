// Phase 16, Wave 4 — Stream B.
//
// SRC-121: two DELETE handlers returned `ok(result)` (200 + body)
// while the other DELETE handlers return `noContent()` (204, empty).
// Both now return 204. The admin hooks only invalidate their queries
// on success, so no caller reads the removed row.
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockSession = { user: { id: "admin-1" } }
const mockRequireAdminApi = vi.hoisted(() => vi.fn(async () => mockSession))
const mockEnforceRateLimit = vi.hoisted(() => vi.fn(async () => null))
vi.mock("@/lib/require-admin-api", () => ({
  requireAdminApi: mockRequireAdminApi,
}))
vi.mock("@/lib/rate-limit", () => ({
  enforceAdminApiRateLimit: mockEnforceRateLimit,
}))
const mockRemoveEntitlementOverride = vi.hoisted(() =>
  vi.fn(async () => ({ deleted: true }))
)
vi.mock("@sendcms/plans", () => ({
  removeEntitlementOverride: mockRemoveEntitlementOverride,
}))
const mockRemoveFlagOverride = vi.hoisted(() =>
  vi.fn(async () => ({ removed: true }))
)
vi.mock("@sendcms/platform-ops", () => ({
  removeFlagOverride: mockRemoveFlagOverride,
}))

import { NextRequest } from "next/server"
import { DELETE as deleteOverride } from "../apps/api/app/api/v1/admin/users/[userId]/overrides/[meter]/route"
import { DELETE as deleteFlagOverride } from "../apps/api/app/api/v1/admin/features/[key]/overrides/[userId]/route"

const repoRoot = path.resolve(import.meta.dirname, "..")

beforeEach(() => {
  vi.clearAllMocks()
})

describe("SRC-121 DELETE handlers return 204 with an empty body", () => {
  it("DELETE an entitlement override → 204, service still called", async () => {
    const res = await deleteOverride(
      new NextRequest(
        "http://localhost:3001/api/v1/admin/users/u1/overrides/FORMS",
        { method: "DELETE" }
      ),
      { params: Promise.resolve({ userId: "u1", meter: "FORMS" }) }
    )
    expect(res.status).toBe(204)
    expect(await res.text()).toBe("")
    expect(mockRemoveEntitlementOverride).toHaveBeenCalledWith(
      mockSession,
      "u1",
      "FORMS"
    )
  })

  it("DELETE a flag override → 204, service still called", async () => {
    const res = await deleteFlagOverride(
      new NextRequest(
        "http://localhost:3001/api/v1/admin/features/ai-features/overrides/u1",
        { method: "DELETE" }
      ),
      {
        params: Promise.resolve({ key: "ai-features", userId: "u1" }),
      }
    )
    expect(res.status).toBe(204)
    expect(await res.text()).toBe("")
    expect(mockRemoveFlagOverride).toHaveBeenCalledWith(
      mockSession,
      "ai-features",
      "u1",
      expect.objectContaining({ correlationId: expect.any(String) })
    )
  })

  it("every v1 DELETE handler returns noContent() on success", () => {
    // The MCP route (outside v1) is a deliberate 405, not a resource
    // delete, so the pin is scoped to v1.
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name === "route.ts") files.push(full)
      }
    }
    walk(path.join(repoRoot, "apps/api/app/api/v1"))
    const deletes = files.filter((f) =>
      readFileSync(f, "utf8").includes("export async function DELETE(")
    )
    expect(deletes.length).toBe(12) // 11 + the Phase D coupons DELETE
    for (const file of deletes) {
      const src = readFileSync(file, "utf8")
      expect(src, `${file}: DELETE returns noContent()`).toContain(
        "return noContent()"
      )
      // The DELETE body itself must not return ok(...) — other
      // handlers in the same file may.
      const deleteBody = src.slice(src.indexOf("export async function DELETE("))
      expect(deleteBody).not.toContain("return ok(")
    }
  })
})
