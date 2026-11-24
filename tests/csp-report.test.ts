/**
 * Phase 16, SRC-318 — the CSP violation report endpoint answers 204
 * with `no-store` for well-formed and malformed reports alike, and
 * never throws.
 */
import { describe, expect, it, vi } from "vitest"

vi.mock("@sendcms/observability", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import { POST } from "@/apps/api/app/api/csp-report/route"

function postReport(body: string) {
  return new Request("http://localhost/api/csp-report", {
    method: "POST",
    headers: { "Content-Type": "application/csp-report" },
    body,
  })
}

describe("POST /api/csp-report", () => {
  it("answers 204 no-store for a well-formed report", async () => {
    const res = await POST(
      postReport(
        JSON.stringify({
          "csp-report": {
            "document-uri": "https://dashboard.sendcms.bond/",
            "blocked-uri": "https://evil.example/x.js",
            "violated-directive": "script-src",
          },
        })
      )
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("answers 204 no-store for a malformed body", async () => {
    const res = await POST(postReport("{not json"))
    expect(res.status).toBe(204)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("answers 204 no-store for an empty body", async () => {
    const res = await POST(postReport(""))
    expect(res.status).toBe(204)
  })
})
