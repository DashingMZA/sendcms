// Public submit route (Phase 5): status codes, CORS echo rules, and the
// no-JS form-post branch — with the service mocked, so these tests pin
// the route's own decisions.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockSubmitForm = vi.hoisted(() => vi.fn())
const mockProcessOutbox = vi.hoisted(() => vi.fn(async () => ({})))
const mockAfter = vi.hoisted(() => vi.fn())
vi.mock("@sendcms/submissions", () => ({
  submitForm: mockSubmitForm,
}))
vi.mock("@sendcms/notifications", () => ({
  processEmailOutbox: mockProcessOutbox,
}))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: mockAfter }
})

import { NextRequest } from "next/server"
import { OPTIONS, POST } from "@/app/api/public/v1/submit/route"
import { ApiError } from "@sendcms/api-client"
import { notificationDeps } from "@/lib/email/notification-deps"

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

  it("returns 422 when the body fails validation", async () => {
    const res = await POST(jsonRequest({ userId: "u" }))
    expect(res.status).toBe(422)
    expect(mockSubmitForm).not.toHaveBeenCalled()
  })

  it("returns 413 when content-length exceeds 64 KB", async () => {
    const res = await POST(
      jsonRequest(VALID_BODY, { "content-length": "64001" })
    )
    expect(res.status).toBe(413)
    expect(mockSubmitForm).not.toHaveBeenCalled()
  })

  it("answers OPTIONS preflight with 204 and CORS headers", async () => {
    const res = await OPTIONS(
      new NextRequest(URL, { method: "OPTIONS", headers: { Origin: ORIGIN } })
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    expect(res.headers.get("access-control-allow-methods")).toContain("POST")
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
    expect(mockProcessOutbox).toHaveBeenCalledWith(notificationDeps, {
      limit: 25,
    })
  })
})
