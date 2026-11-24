// Origin/Referer validation on state-changing /api/v1/* requests
// (Phase 16, Wave 1: SEC-202). The api app's proxy rejects a
// present-but-untrusted origin with 403 before the route runs, so a
// cross-origin POST carrying a valid session cookie never reaches
// the handler. SameSite=Lax alone was the only defence before this.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { proxy } from "../apps/api/proxy"

const API = "http://localhost:3001"

function v1Request(
  path: string,
  method: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "GET" ? undefined : "{}",
  })
}

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_URL", API)
  vi.stubEnv("TRUSTED_ORIGINS", "http://localhost:3002")
  vi.stubEnv("NEXT_PUBLIC_DASHBOARD_URL", "http://localhost:3002")
  vi.stubEnv("NEXT_PUBLIC_ADMIN_URL", "http://localhost:3006")
  vi.stubEnv("NEXT_PUBLIC_API_URL", API)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("proxy origin check on /api/v1/* (SEC-202)", () => {
  it("rejects a state-changing POST from an evil origin with 403", async () => {
    const res = await proxy(
      v1Request("/api/v1/forms", "POST", { Origin: "http://evil.example" })
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("origin"),
    })
  })

  it("rejects an evil Referer when no Origin is sent", async () => {
    const res = await proxy(
      v1Request("/api/v1/forms", "POST", {
        Referer: "http://evil.example/dashboard",
      })
    )
    expect(res.status).toBe(403)
  })

  it("allows a POST from the dashboard origin", async () => {
    const res = await proxy(
      v1Request("/api/v1/forms", "POST", { Origin: "http://localhost:3002" })
    )
    expect(res.status).toBe(200)
  })

  it("allows a same-origin POST", async () => {
    const res = await proxy(v1Request("/api/v1/forms", "POST", { Origin: API }))
    expect(res.status).toBe(200)
  })

  it("allows a POST with no Origin at all (non-browser clients)", async () => {
    const res = await proxy(v1Request("/api/v1/forms", "POST"))
    expect(res.status).toBe(200)
  })

  it("does not origin-check GETs", async () => {
    const res = await proxy(
      v1Request("/api/v1/forms", "GET", { Origin: "http://evil.example" })
    )
    expect(res.status).toBe(200)
  })

  it("does not origin-check the auth routes or the public submit route", async () => {
    const auth = await proxy(
      v1Request("/api/auth/sign-in/email", "POST", {
        Origin: "http://evil.example",
      })
    )
    expect(auth.status).toBe(200)
    const submit = await proxy(
      v1Request("/api/public/v1/submit", "POST", {
        Origin: "http://evil.example",
      })
    )
    expect(submit.status).toBe(200)
  })
})
