// TST-003 (Phase 16, Wave 12): route tests for five previously
// unloaded API routes — the cheap, no-DB or mocked-service ones.
// Each route is loaded with its service seam mocked, so these tests
// pin the route's own decisions (status codes, auth gating, 405s).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import type { EmailOutboxCronResult } from "@sendcms/cron"
import type { AnnouncementRow } from "@sendcms/platform-ops"

const mockPingDatabase = vi.hoisted(() => vi.fn())
// Typed from the real signatures: getLastCronRun returns
// EmailOutboxCronResult | null, listActiveAnnouncements returns
// { announcements: AnnouncementRow[] } — the bare `() => null` /
// `async () => []` defaults infer `null` / `never[]` and reject the
// real-shaped values below.
const mockGetLastCronRun = vi.hoisted(() =>
  vi.fn((): EmailOutboxCronResult | null => null)
)
vi.mock("@sendcms/database", () => ({
  pingDatabase: mockPingDatabase,
}))
vi.mock("@sendcms/cron", () => ({
  getLastCronRun: mockGetLastCronRun,
}))

const mockVerifyUnsubscribeToken = vi.hoisted(() => vi.fn())
const mockUnsubscribeRecipient = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@sendcms/email", () => ({
  verifyUnsubscribeToken: mockVerifyUnsubscribeToken,
}))
vi.mock("@sendcms/notifications", () => ({
  unsubscribeRecipient: mockUnsubscribeRecipient,
}))

const mockAuth = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth", () => ({ auth: mockAuth }))
const mockListActiveAnnouncements = vi.hoisted(() =>
  vi.fn(async (): Promise<{ announcements: AnnouncementRow[] }> => ({
    announcements: [],
  }))
)
vi.mock("@sendcms/platform-ops", () => ({
  listActiveAnnouncements: mockListActiveAnnouncements,
}))

import { GET as healthGet } from "../apps/api/app/api/health/route"
import { GET as healthDeepGet } from "../apps/api/app/api/health/deep/route"
import { POST as cspReportPost } from "../apps/api/app/api/csp-report/route"
import {
  GET as unsubscribeGet,
  POST as unsubscribePost,
} from "../apps/api/app/api/public/v1/unsubscribe/route"
import { GET as announcementsGet } from "../apps/api/app/api/v1/announcements/active/route"

beforeEach(() => {
  vi.clearAllMocks()
  mockGetLastCronRun.mockReturnValue(null)
})

describe("GET /api/health", () => {
  it("answers 200 from memory, without touching the database", async () => {
    const res = await healthGet()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(typeof body.uptimeSeconds).toBe("number")
    expect(mockPingDatabase).not.toHaveBeenCalled()
  })
})

describe("GET /api/health/deep", () => {
  it("answers 200 with the DB health and the last cron run", async () => {
    mockPingDatabase.mockResolvedValue({ status: "ok", latencyMs: 3 })
    // A real EmailOutboxCronResult (all numbers/strings/null, so the
    // JSON round-trip is identity) — not a bare timestamp string.
    const lastRun: EmailOutboxCronResult = {
      processed: 5,
      sent: 4,
      failed: 1,
      skipped: 0,
      outboxError: null,
      rescored: 2,
      markedSpam: 0,
      rescoreSkipped: 0,
      rescoreError: null,
      digests: 1,
      digestSkipped: 0,
      digestError: null,
      subscriptionsExpired: 0,
      subscriptionsCanceled: 0,
      expiryError: null,
      reconciled: 0,
      reconcileJobsCreated: 0,
      reconcileError: null,
      durationMs: 123,
      runAt: "2026-11-27T07:00:00.000Z",
    }
    mockGetLastCronRun.mockReturnValue(lastRun)
    const res = await healthDeepGet()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.lastCronRun).toEqual(lastRun)
  })

  it("answers 500 when the database ping throws", async () => {
    mockPingDatabase.mockRejectedValue(new Error("db down"))
    const res = await healthDeepGet()
    expect(res.status).toBe(500)
  })
})

describe("POST /api/csp-report", () => {
  const post = (body: string) =>
    cspReportPost(
      new Request("http://localhost:3001/api/csp-report", {
        method: "POST",
        headers: { "Content-Type": "application/csp-report" },
        body,
      })
    )

  it("answers 204 for a valid report", async () => {
    const res = await post(
      JSON.stringify({
        "csp-report": {
          "document-uri": "https://example.com/",
          "blocked-uri": "https://evil.example/x.js",
          "violated-directive": "script-src",
        },
      })
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("answers 204 for a malformed report instead of a 500", async () => {
    const res = await post("{not json")
    expect(res.status).toBe(204)
  })

  it("answers 204 for an oversized report (body capped, never a 500)", async () => {
    const res = await post("x".repeat(20_000))
    expect(res.status).toBe(204)
  })
})

describe("GET /api/public/v1/unsubscribe", () => {
  const get = (token: string | null) =>
    unsubscribeGet(
      new NextRequest(
        `http://localhost:3001/api/public/v1/unsubscribe${token === null ? "" : `?token=${token}`}`
      )
    )

  it("answers 400 with no token", async () => {
    const res = await get(null)
    expect(res.status).toBe(400)
    expect(mockUnsubscribeRecipient).not.toHaveBeenCalled()
  })

  it("answers 400 for an invalid token", async () => {
    mockVerifyUnsubscribeToken.mockReturnValue(null)
    const res = await get("bad-token")
    expect(res.status).toBe(400)
    expect(mockUnsubscribeRecipient).not.toHaveBeenCalled()
  })

  it("unsubscribes and answers an HTML confirmation for a valid form-scoped token", async () => {
    mockVerifyUnsubscribeToken.mockReturnValue({
      email: "ali@example.com",
      formId: "form-1",
    })
    const res = await get("good-token")
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/html")
    expect(mockUnsubscribeRecipient).toHaveBeenCalledWith({
      email: "ali@example.com",
      formId: "form-1",
    })
    const html = await res.text()
    expect(html).toContain("ali@example.com")
    expect(html).toContain("notification emails for this form")
  })

  it("names the global scope for a token with no form", async () => {
    mockVerifyUnsubscribeToken.mockReturnValue({
      email: "ali@example.com",
      formId: null,
    })
    const res = await get("good-token")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("all SendCMS notification emails")
  })

  it("escapes the email in the confirmation page", async () => {
    mockVerifyUnsubscribeToken.mockReturnValue({
      email: "a<b@example.com",
      formId: "form-1",
    })
    const res = await get("good-token")
    const html = await res.text()
    expect(html).toContain("a&lt;b@example.com")
    expect(html).not.toContain("a<b@example.com")
  })

  it("answers 405 for POST (GET only, SDK-031)", async () => {
    const res = await unsubscribePost()
    expect(res.status).toBe(405)
    expect(res.headers.get("Allow")).toBe("GET")
  })
})

describe("GET /api/v1/announcements/active", () => {
  it("answers 401 with no session", async () => {
    mockAuth.mockResolvedValue(null)
    const res = await announcementsGet()
    expect(res.status).toBe(401)
    expect(mockListActiveAnnouncements).not.toHaveBeenCalled()
  })

  it("shows a customer ALL announcements only", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-1", platformRole: "PLATFORM_USER", adminRole: null },
    })
    // A real AnnouncementRow; the route returns ok({ announcements })
    // and JSON serialises the Dates to ISO strings.
    const row: AnnouncementRow = {
      id: "a-1",
      title: "Hello",
      body: "World",
      audience: "ALL",
      isActive: true,
      startsAt: null,
      endsAt: null,
      createdBy: null,
      createdAt: new Date("2026-11-27T07:00:00.000Z"),
      updatedAt: new Date("2026-11-27T07:00:00.000Z"),
    }
    mockListActiveAnnouncements.mockResolvedValue({ announcements: [row] })
    const res = await announcementsGet()
    expect(res.status).toBe(200)
    expect(mockListActiveAnnouncements).toHaveBeenCalledWith(false)
    expect(await res.json()).toEqual({
      announcements: [
        {
          ...row,
          createdAt: "2026-11-27T07:00:00.000Z",
          updatedAt: "2026-11-27T07:00:00.000Z",
        },
      ],
    })
  })

  it("shows an owner ALL + ADMIN_ONLY announcements", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-1", platformRole: "PLATFORM_OWNER", adminRole: null },
    })
    const res = await announcementsGet()
    expect(res.status).toBe(200)
    expect(mockListActiveAnnouncements).toHaveBeenCalledWith(true)
  })
})
