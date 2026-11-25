// Public submit route (Phase 5): status codes, CORS echo rules, and the
// no-JS form-post branch — with the service mocked, so these tests pin
// the route's own decisions.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockSubmitForm = vi.hoisted(() => vi.fn())
const mockProcessOutbox = vi.hoisted(() => vi.fn(async () => ({})))
const mockAfter = vi.hoisted(() => vi.fn())
const mockIsVerifiedOrigin = vi.hoisted(() => vi.fn(async () => true))
vi.mock("@sendcms/submissions", () => ({
  submitForm: mockSubmitForm,
}))
vi.mock("@sendcms/domains", () => ({
  isVerifiedOrigin: mockIsVerifiedOrigin,
}))
vi.mock("@sendcms/notifications", () => ({
  processEmailOutbox: mockProcessOutbox,
}))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: mockAfter }
})

import { NextRequest } from "next/server"
// The submit route lives in apps/api (Phase 7); the test suite still
// lives at the repo root until Phase 13 co-locates tests with the code
// they cover, so it reaches the route by relative path.
import { OPTIONS, POST } from "../apps/api/app/api/public/v1/submit/route"
import { ApiError } from "@sendcms/api-client"

const URL = "http://localhost:3000/api/public/v1/submit"
const ORIGIN = "https://example.com"

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

function formRequest(params: Record<string, string>, referer: string) {
  return new NextRequest(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: ORIGIN,
      Referer: referer,
    },
    body: new URLSearchParams(params).toString(),
  })
}

const VALID_BODY = {
  userId: "user-1",
  formId: "form-1",
  fields: { name: "Ali", email: "ali@example.com", message: "Hello" },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSubmitForm.mockResolvedValue({
    kind: "created",
    submission: { id: "sub-1" },
    originAllowed: true,
    message: "Thanks!",
    redirectUrl: null,
  })
})

describe("POST /api/public/v1/submit", () => {
  it("returns 201 with CORS headers and the submission id on success", async () => {
    const res = await POST(jsonRequest(VALID_BODY))
    expect(res.status).toBe(201)
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    const body = await res.json()
    expect(body).toEqual({
      ok: true,
      id: "sub-1",
      message: "Thanks!",
      redirectUrl: null,
    })
    expect(mockSubmitForm).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", formId: "form-1" }),
      expect.objectContaining({ origin: ORIGIN, ip: null })
    )
    expect(mockAfter).toHaveBeenCalledTimes(1)
  })

  it("returns 200 for a duplicate", async () => {
    mockSubmitForm.mockResolvedValue({
      kind: "duplicate",
      submission: { id: "sub-1" },
      originAllowed: true,
      message: "Thanks!",
      redirectUrl: null,
    })
    const res = await POST(jsonRequest(VALID_BODY))
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe("sub-1")
    expect(mockAfter).not.toHaveBeenCalled()
  })

  it("returns 201 with the fake id for a honeypot result", async () => {
    mockSubmitForm.mockResolvedValue({
      kind: "honeypot",
      fakeId: "fake-1",
      originAllowed: true,
      message: "Thanks!",
      redirectUrl: null,
    })
    const res = await POST(jsonRequest(VALID_BODY))
    expect(res.status).toBe(201)
    expect((await res.json()).id).toBe("fake-1")
  })

  it("passes the first x-forwarded-for entry as the client IP", async () => {
    await POST(
      jsonRequest(VALID_BODY, { "x-forwarded-for": "9.9.9.9, 1.2.3.4" })
    )
    expect(mockSubmitForm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ip: "9.9.9.9" })
    )
  })

  it("does not echo CORS headers when the origin was rejected", async () => {
    const err = new ApiError("This form does not accept submissions.", 403)
    err.originAllowed = false
    mockSubmitForm.mockRejectedValue(err)
    const res = await POST(jsonRequest(VALID_BODY))
    expect(res.status).toBe(403)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
    expect((await res.json()).error).toContain("does not accept")
  })

  it("echoes CORS headers on an error when the origin was allowed", async () => {
    const err = new ApiError("Daily limit reached.", 429)
    err.originAllowed = true
    mockSubmitForm.mockRejectedValue(err)
    const res = await POST(jsonRequest(VALID_BODY))
    expect(res.status).toBe(429)
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN)
  })

  // SDK-019: a rate-limit throw carries `retryAfterSeconds` — the
  // route surfaces it as a Retry-After header on the JSON error.
  it("emits Retry-After from a rate-limit error's retryAfterSeconds (SDK-019)", async () => {
    const err = new ApiError("Too many submissions. Please wait a minute.", 429)
    err.originAllowed = true
    ;(err as ApiError & { retryAfterSeconds?: number }).retryAfterSeconds = 60
    mockSubmitForm.mockRejectedValue(err)
    const res = await POST(jsonRequest(VALID_BODY))
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("60")
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN)
  })

  it("omits Retry-After when the error carries no wait (SDK-019)", async () => {
    const err = new ApiError("This form does not accept submissions.", 403)
    err.originAllowed = true
    mockSubmitForm.mockRejectedValue(err)
    const res = await POST(jsonRequest(VALID_BODY))
    expect(res.status).toBe(403)
    expect(res.headers.get("retry-after")).toBeNull()
  })

  it("returns 422 when the body fails validation", async () => {
    const res = await POST(jsonRequest({ userId: "u" }))
    expect(res.status).toBe(422)
    expect(mockSubmitForm).not.toHaveBeenCalled()
  })

  // SDK-015 / SDK-022: pre-service errors (route-level Zod 422, the
  // 413 size guard, malformed JSON, the form-lookup 404) never reach
  // the service's allowlist check, so originAllowed is unset. They
  // echo CORS when the origin's host is a VERIFIED domain — and only
  // then.
  it("echoes CORS on a route-level 422 from a verified origin (SDK-015/SDK-022)", async () => {
    const res = await POST(jsonRequest({ userId: "u" }))
    expect(res.status).toBe(422)
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    expect((await res.json()).error).toContain("Invalid input")
  })

  it("carries no CORS on a route-level 422 from an unverified origin (SDK-015/SDK-022)", async () => {
    mockIsVerifiedOrigin.mockResolvedValueOnce(false)
    const res = await POST(jsonRequest({ userId: "u" }))
    expect(res.status).toBe(422)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("echoes CORS on a 413 from a verified origin and not from an unverified one (SDK-022)", async () => {
    const verified = await POST(
      jsonRequest(VALID_BODY, { "content-length": "64001" })
    )
    expect(verified.status).toBe(413)
    expect(verified.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    mockIsVerifiedOrigin.mockResolvedValueOnce(false)
    const unverified = await POST(
      jsonRequest(VALID_BODY, { "content-length": "64001" })
    )
    expect(unverified.status).toBe(413)
    expect(unverified.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("echoes CORS on the service form-lookup 404 from a verified origin (SDK-022)", async () => {
    mockSubmitForm.mockRejectedValue(new ApiError("Form not found", 404))
    const res = await POST(jsonRequest(VALID_BODY))
    expect(res.status).toBe(404)
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN)
  })

  it("still carries no CORS when the service explicitly rejected the origin, even if the domain is verified (SDK-015/SDK-022)", async () => {
    const err = new ApiError(
      "This form does not accept submissions from this site.",
      403
    )
    err.originAllowed = false
    mockSubmitForm.mockRejectedValue(err)
    const res = await POST(jsonRequest(VALID_BODY))
    expect(res.status).toBe(403)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
    // The verified-domain fallback must not even be consulted once
    // the service has decided.
    expect(mockIsVerifiedOrigin).not.toHaveBeenCalled()
  })

  // SDK-017 / SDK-023: malformed JSON is a clean 400, not a 422 with
  // a raw Zod dump.
  it("returns 400 with 'Malformed JSON body.' for syntactically invalid JSON (SDK-017/SDK-023)", async () => {
    const res = await POST(
      new NextRequest(URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
        },
        body: '{"userId": broken json',
      })
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Malformed JSON body." })
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    expect(mockSubmitForm).not.toHaveBeenCalled()
  })

  it("returns 400 without CORS for malformed JSON from an unverified origin (SDK-017/SDK-023)", async () => {
    mockIsVerifiedOrigin.mockResolvedValueOnce(false)
    const res = await POST(
      new NextRequest(URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: "{bad json",
      })
    )
    expect(res.status).toBe(400)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("keeps the Zod 422 messages for a well-formed but invalid body (SDK-017)", async () => {
    const res = await POST(jsonRequest({}))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toContain("Invalid input")
    expect(mockSubmitForm).not.toHaveBeenCalled()
  })

  // SRC-237: the service reports monthly quota exhaustion as 402;
  // the route remaps it to 429, the documented vocabulary.
  it("remaps a service 402 quota error to 429 with the same message (SRC-237)", async () => {
    const err = new ApiError(
      "This form's monthly submission quota is exhausted.",
      402
    )
    err.originAllowed = true
    mockSubmitForm.mockRejectedValue(err)
    const res = await POST(jsonRequest(VALID_BODY))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({
      error: "This form's monthly submission quota is exhausted.",
    })
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN)
  })

  it("returns 413 when content-length exceeds 64 KB", async () => {
    const res = await POST(
      jsonRequest(VALID_BODY, { "content-length": "64001" })
    )
    expect(res.status).toBe(413)
    expect(mockSubmitForm).not.toHaveBeenCalled()
  })

  it("answers OPTIONS preflight with 204 and CORS headers for a verified origin", async () => {
    const res = await OPTIONS(
      new NextRequest(URL, { method: "OPTIONS", headers: { Origin: ORIGIN } })
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    expect(res.headers.get("access-control-allow-methods")).toContain("POST")
    expect(res.headers.get("access-control-allow-credentials")).toBeNull()
  })

  it("answers OPTIONS with a bare 204 and no CORS headers for an unverified origin (SDK-021 / SEC-207)", async () => {
    mockIsVerifiedOrigin.mockResolvedValueOnce(false)
    const res = await OPTIONS(
      new NextRequest(URL, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example" },
      })
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
    expect(res.headers.get("access-control-allow-methods")).toBeNull()
  })

  it("answers OPTIONS with a bare 204 and no CORS headers when no origin is sent", async () => {
    mockIsVerifiedOrigin.mockClear()
    const res = await OPTIONS(new NextRequest(URL, { method: "OPTIONS" }))
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
    expect(mockIsVerifiedOrigin).not.toHaveBeenCalled()
  })

  it("redirects a form post to the referer with cms_submitted=1", async () => {
    const res = await POST(
      formRequest(
        {
          userId: "user-1",
          formId: "form-1",
          name: "Ali",
          email: "ali@example.com",
          message: "Hello",
        },
        "https://example.com/contact"
      )
    )
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe(
      "https://example.com/contact?cms_submitted=1"
    )
  })

  it("redirects a form post to the form redirectUrl when set", async () => {
    mockSubmitForm.mockResolvedValue({
      kind: "created",
      submission: { id: "sub-1" },
      originAllowed: true,
      message: "Thanks!",
      redirectUrl: "https://example.com/thanks",
    })
    const res = await POST(
      formRequest(
        {
          userId: "user-1",
          formId: "form-1",
          name: "Ali",
          email: "ali@example.com",
          message: "Hello",
        },
        "https://example.com/contact"
      )
    )
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("https://example.com/thanks")
  })

  it("redirects a failed form post back with cms_error", async () => {
    mockSubmitForm.mockRejectedValue(
      new ApiError("This form does not accept submissions.", 403)
    )
    const res = await POST(
      formRequest(
        {
          userId: "user-1",
          formId: "form-1",
          name: "Ali",
          email: "ali@example.com",
          message: "Hello",
        },
        "https://example.com/contact"
      )
    )
    expect(res.status).toBe(303)
    const location = res.headers.get("location") ?? ""
    expect(location).toContain("cms_error=")
    expect(location).toContain("does+not+accept")
  })

  it("runs the outbox attempt after a created submission", async () => {
    await POST(jsonRequest(VALID_BODY))
    expect(mockAfter).toHaveBeenCalledTimes(1)
    const [callback] = mockAfter.mock.calls[0] as [() => Promise<void>]
    await callback()
    expect(mockProcessOutbox).toHaveBeenCalledWith({
      limit: 25,
    })
  })
})
