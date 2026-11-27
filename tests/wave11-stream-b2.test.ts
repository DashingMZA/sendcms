// SendCMS Phase 16 Wave 11 — Stream B2 regression tests.
// Cross-cutting additions that belong to no single module's suite:
// DB-046 detail caps, DB-048 page caps, PRF-018 heartbeat, and the
// LVE-014 / LVE-021 static file assertions.
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AdminSession } from "@sendcms/auth"

const mockDb = vi.hoisted(() => ({
  submission: { findFirst: vi.fn() },
  submissionEvent: { count: vi.fn() },
  supportTicket: { findUnique: vi.fn() },
  $queryRaw: vi.fn(),
}))

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

import { getSubmissionForUser, listSubmissionsForUser } from "@sendcms/inbox"
import { getTicket } from "@sendcms/support"
import {
  pingCronHeartbeat,
  readCronHeartbeatUrl,
  resetCronHeartbeatConfigCache,
} from "@sendcms/cron"
import { AdminPaginationQuerySchema as AdminUsersPaginationQuerySchema } from "@sendcms/admin-users/validators"
import { AdminPaginationQuerySchema as PlansPaginationQuerySchema } from "@sendcms/plans/validators"
import {
  AuditLogsQuerySchema,
  PlatformOpsPaginationQuerySchema,
} from "@sendcms/platform-ops/validators"
import { McpPaginationQuerySchema } from "@sendcms/mcp-admin/validators"
import { SupportPaginationQuerySchema } from "@sendcms/support/validators"
import { AiPaginationQuerySchema } from "@sendcms/ai-settings/validators"
import { InboxListQuerySchema } from "@sendcms/inbox/validators"

const ownerSession: AdminSession = {
  user: {
    id: "admin-1",
    name: "Admin",
    email: "admin@example.com",
    image: null,
    platformRole: "PLATFORM_OWNER",
    status: "ACTIVE",
    adminRole: null,
    emailVerified: true,
  },
  session: { id: "sess-1", userId: "admin-1", expiresAt: new Date() },
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  delete process.env.CRON_HEARTBEAT_URL
  resetCronHeartbeatConfigCache()
})

// ─── DB-046: detail endpoints are bounded ────────────────────────────

describe("DB-046 detail caps", () => {
  it("caps a 500-event submission history at 50 rows, newest first, with a count", async () => {
    const allEvents = Array.from({ length: 500 }, (_, i) => ({
      id: `evt-${i}`,
      createdAt: new Date(Date.now() - i * 1000),
    }))
    mockDb.submission.findFirst.mockImplementation(
      async (args: { include: { events: { take: number } } }) => ({
        id: "sub-1",
        events: allEvents.slice(0, args.include.events.take),
      })
    )
    mockDb.submissionEvent.count.mockResolvedValue(500)

    const detail = await getSubmissionForUser("user-1", "sub-1")

    expect(mockDb.submission.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          events: expect.objectContaining({ take: 50 }),
        }),
      })
    )
    expect(detail.events).toHaveLength(50)
    expect(detail.eventCount).toBe(500)
    expect(detail.hasMoreEvents).toBe(true)
    // Newest first: the first returned event is the newest.
    expect(detail.events[0]?.id).toBe("evt-0")
  })

  it("caps a 500-message ticket thread at 100 rows with a count, in display order", async () => {
    const newestFirst = Array.from({ length: 500 }, (_, i) => ({
      id: `msg-${i}`,
      authorId: "user-1",
      author: { id: "user-1", name: "User", email: "user@example.com" },
      body: `message ${i}`,
      createdAt: new Date(Date.now() - i * 1000),
    }))
    mockDb.supportTicket.findUnique.mockImplementation(
      async (args: { include: { messages: { take: number } } }) => ({
        id: "ticket-1",
        userId: "user-1",
        user: { id: "user-1", name: "User", email: "user@example.com" },
        subject: "Help",
        status: "OPEN",
        priority: "NORMAL",
        assignedToId: null,
        assignedTo: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        messages: newestFirst.slice(0, args.include.messages.take),
        _count: { messages: 500 },
      })
    )

    const detail = await getTicket(ownerSession, "ticket-1")

    expect(mockDb.supportTicket.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          messages: expect.objectContaining({ take: 100 }),
        }),
      })
    )
    expect(detail.messages).toHaveLength(100)
    expect(detail.hasMoreMessages).toBe(true)
    // Display order: the page is reversed, so the oldest message of
    // the newest-100 page comes first — and the reply itself (the
    // newest row) is never dropped by the cap.
    expect(detail.messages[0]?.id).toBe("msg-99")
    expect(detail.messages[99]?.id).toBe("msg-0")
  })
})

// ─── DB-048: page caps ───────────────────────────────────────────────

describe("DB-048 page caps", () => {
  it("rejects page 100000 in every shared pagination schema", () => {
    for (const [name, schema] of [
      ["admin-users", AdminUsersPaginationQuerySchema],
      ["plans", PlansPaginationQuerySchema],
      ["platform-ops", PlatformOpsPaginationQuerySchema],
      ["mcp-admin", McpPaginationQuerySchema],
      ["support", SupportPaginationQuerySchema],
      ["ai-settings", AiPaginationQuerySchema],
    ] as const) {
      expect(
        schema.safeParse({ page: "100000" }),
        `${name} must reject page 100000`
      ).toMatchObject({ success: false })
      expect(schema.safeParse({ page: "1000" }).success).toBe(true)
    }
  })

  // The finding's exact example: GET /api/v1/admin/audit-logs
  // ?page=100000 → 422 at the route's schema, not a 2M-row scan.
  it("rejects page 100000 on the audit-logs query (the finding's example)", () => {
    expect(AuditLogsQuerySchema.safeParse({ page: "100000" })).toMatchObject({
      success: false,
    })
  })

  it("falls the inbox query back to page 1 instead of 422 (catch semantics)", () => {
    const parsed = InboxListQuerySchema.safeParse({ page: "100000" })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.page).toBe(1)
  })

  it("clamps a direct service caller's page 100000 to 1000 (inbox raw-SQL list)", async () => {
    const captured: unknown[] = []
    mockDb.$queryRaw
      .mockImplementationOnce(async (sql: { values: unknown[] }) => {
        captured.push(sql.values)
        return []
      })
      .mockImplementationOnce(async () => [{ n: 0 }])
      .mockImplementationOnce(async () => [])
    const result = await listSubmissionsForUser("user-1", {
      page: 100000,
    } as never)
    expect(result.page).toBe(1000)
    // (1000 - 1) * 20 = 19980 — the deepest offset served, never the
    // ~2M-row offset page 100000 would have asked for.
    expect(captured[0]).toContain(19980)
  })
})

// ─── PRF-018: cron heartbeat ─────────────────────────────────────────

describe("PRF-018 cron heartbeat", () => {
  function tempWorkspace(withConfig: string | null) {
    const dir = mkdtempSync(join(tmpdir(), "wave11-b2-hb-"))
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "")
    if (withConfig !== null) {
      mkdirSync(join(dir, "config"), { recursive: true })
      writeFileSync(join(dir, "config", "config.json"), withConfig)
    }
    return dir
  }

  it("prefers env CRON_HEARTBEAT_URL over the config file", () => {
    const dir = tempWorkspace(
      JSON.stringify({
        monitoring: { cronHeartbeatUrl: "https://hb.example/from-config" },
      })
    )
    const prev = process.cwd()
    process.chdir(dir)
    try {
      resetCronHeartbeatConfigCache()
      process.env.CRON_HEARTBEAT_URL = "https://hb.example/from-env"
      expect(readCronHeartbeatUrl()).toBe("https://hb.example/from-env")
    } finally {
      process.chdir(prev)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("falls back to config/config.json monitoring.cronHeartbeatUrl", () => {
    const dir = tempWorkspace(
      JSON.stringify({
        monitoring: { cronHeartbeatUrl: "https://hb.example/from-config" },
      })
    )
    const prev = process.cwd()
    process.chdir(dir)
    try {
      resetCronHeartbeatConfigCache()
      expect(readCronHeartbeatUrl()).toBe("https://hb.example/from-config")
    } finally {
      process.chdir(prev)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("is a no-op when no heartbeat URL is configured", async () => {
    const dir = tempWorkspace(null)
    const prev = process.cwd()
    process.chdir(dir)
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal("fetch", fetchMock)
    try {
      resetCronHeartbeatConfigCache()
      expect(readCronHeartbeatUrl()).toBeNull()
      await pingCronHeartbeat("cron-route")
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      process.chdir(prev)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("pings the configured URL once per run and never throws when the monitor is down", async () => {
    process.env.CRON_HEARTBEAT_URL = "https://hb.example/ping"
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal("fetch", fetchMock)
    await pingCronHeartbeat("worker")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hb.example/ping",
      expect.objectContaining({ method: "GET" })
    )

    fetchMock.mockRejectedValueOnce(new Error("monitor down"))
    await expect(pingCronHeartbeat("worker")).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// ─── LVE-014 / LVE-021: static file assertions ───────────────────────

// Minimal string-aware JSONC reader: strip // comments outside
// strings + trailing commas, then JSON.parse. (A naive // strip
// breaks on the https:// values in the wranglers.)
function parseJsonc(text: string): unknown {
  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    out += ch
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, "$1")) as unknown
}

const WRANGLER_APPS = [
  "admin",
  "api",
  "dashboard",
  "docs",
  "marketing",
  "updates",
] as const

describe("LVE-014 observability", () => {
  it("enables Cloudflare observability in all six wranglers", () => {
    for (const app of WRANGLER_APPS) {
      const parsed = parseJsonc(
        readFileSync(join(process.cwd(), "apps", app, "wrangler.jsonc"), "utf8")
      ) as { observability?: { enabled?: unknown } }
      expect(
        parsed.observability?.enabled,
        `${app}/wrangler.jsonc must have observability.enabled: true`
      ).toBe(true)
    }
  })
})

describe("LVE-021 Dockerfile healthcheck", () => {
  it("declares EXPOSE, a per-app HEALTHCHECK, and an APP build-arg guard", () => {
    const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8")
    expect(dockerfile).toContain("EXPOSE 3000")
    expect(dockerfile).toContain("HEALTHCHECK")
    // Per-app health path: the api app answers /api/health, the
    // email worker /health, every other app /.
    expect(dockerfile).toContain("/api/health")
    expect(dockerfile).toContain("wget")
    expect(dockerfile).toMatch(/missing --build-arg APP/)
  })
})
