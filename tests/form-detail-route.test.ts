// SDK-016: GET /api/v1/forms/[formId] reports whether the API
// server can verify Turnstile tokens, so the dashboard can warn when
// a Turnstile-enabled form is bricked by a missing server secret.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockAuth = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth", () => ({ auth: mockAuth }))

const mockGetFormForUser = vi.hoisted(() => vi.fn())
vi.mock("@sendcms/forms", () => ({
  getFormForUser: mockGetFormForUser,
  updateFormForUser: vi.fn(),
  deleteFormForUser: vi.fn(),
}))

import { NextRequest } from "next/server"
import { GET } from "../apps/api/app/api/v1/forms/[formId]/route"

const URL = "http://localhost:3001/api/v1/forms/form-1"

const originalSecret = process.env.TURNSTILE_SECRET_KEY

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "user-1" } })
  mockGetFormForUser.mockResolvedValue({
    id: "form-1",
    name: "Contact us",
    turnstileEnabled: true,
  })
})

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.TURNSTILE_SECRET_KEY
  } else {
    process.env.TURNSTILE_SECRET_KEY = originalSecret
  }
})

describe("GET /api/v1/forms/[formId] turnstileConfigured (SDK-016)", () => {
  it("reports false when TURNSTILE_SECRET_KEY is unset", async () => {
    delete process.env.TURNSTILE_SECRET_KEY
    const res = await GET(new NextRequest(URL), {
      params: Promise.resolve({ formId: "form-1" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.turnstileConfigured).toBe(false)
    expect(body.id).toBe("form-1")
  })

  it("reports true when TURNSTILE_SECRET_KEY is set", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret"
    const res = await GET(new NextRequest(URL), {
      params: Promise.resolve({ formId: "form-1" }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).turnstileConfigured).toBe(true)
  })

  it("401s with no session", async () => {
    mockAuth.mockResolvedValueOnce(null)
    const res = await GET(new NextRequest(URL), {
      params: Promise.resolve({ formId: "form-1" }),
    })
    expect(res.status).toBe(401)
  })
})
