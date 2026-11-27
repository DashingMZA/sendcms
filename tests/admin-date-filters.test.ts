// Phase 16, Wave 4 — Stream B.
//
// SRC-119: the usage route validated `period` twice — once in the
// schema (as a plain string) and once by hand-rolling a second 422
// when `new Date(...)` was NaN. The route now validates the period
// with the shared date helper, in the same 422 shape as the schema
// failure.
//
// SRC-231: `?from=garbage` on the usage/audit/submission lists used
// to return unfiltered results — the service builders silently
// skipped unparseable dates. The routes now 422 before the service
// ever runs.
//
// SRC-112: the billing provider route parsed the provider name by
// importing the Prisma enum value from the database package. It now
// parses through the billing module's own validator; this also pins
// that no route imports the database package at runtime (except the
// allowlisted health route).
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

const mockGetUsage = vi.hoisted(() => vi.fn(async () => ({ usage: [] })))
vi.mock("@sendcms/plans", () => ({
  getUsage: mockGetUsage,
  startOfUtcMonth: () => new Date("2026-11-01T00:00:00.000Z"),
}))
const mockListAiUsage = vi.hoisted(() =>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- params exist only so mock.calls[0][1] types
  vi.fn(async (_actor: unknown, _filters: unknown) => ({ usage: [] }))
)
const mockGetAiUsageSummary = vi.hoisted(() =>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- params exist only so mock.calls[0][1] types
  vi.fn(async (_actor: unknown, _filters: unknown) => ({ totals: {} }))
)
vi.mock("@sendcms/ai-settings", () => ({
  listAiUsage: mockListAiUsage,
  getAiUsageSummary: mockGetAiUsageSummary,
}))
const mockListMcpUsage = vi.hoisted(() =>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- params exist only so mock.calls[0][1] types
  vi.fn(async (_actor: unknown, _filters: unknown) => ({ usage: [] }))
)
const mockGetMcpUsageSummary = vi.hoisted(() =>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- params exist only so mock.calls[0][1] types
  vi.fn(async (_actor: unknown, _filters: unknown) => ({ totals: {} }))
)
vi.mock("@sendcms/mcp-admin", () => ({
  listMcpUsage: mockListMcpUsage,
  getMcpUsageSummary: mockGetMcpUsageSummary,
}))
const mockListAuditLogs = vi.hoisted(() =>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- params exist only so mock.calls[0][1] types
  vi.fn(async (_actor: unknown, _filters: unknown) => ({ logs: [] }))
)
const mockExportAuditLogs = vi.hoisted(() =>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- params exist only so mock.calls[0][1] types
  vi.fn(async (_actor: unknown, _filters: unknown) => ({ logs: [] }))
)
const mockListPlatformSubmissions = vi.hoisted(() =>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- params exist only so mock.calls[0][1] types
  vi.fn(async (_actor: unknown, _filters: unknown) => ({ submissions: [] }))
)
vi.mock("@sendcms/platform-ops", () => ({
  listAuditLogs: mockListAuditLogs,
  exportAuditLogs: mockExportAuditLogs,
  listPlatformSubmissions: mockListPlatformSubmissions,
}))
const mockSetProviderConfig = vi.hoisted(() =>
  vi.fn(async () => ({ provider: "STRIPE" }))
)
vi.mock("@sendcms/billing", () => ({
  setProviderConfig: mockSetProviderConfig,
}))

import { NextRequest } from "next/server"
import { GET as usageGET } from "../apps/api/app/api/v1/admin/usage/route"
import { GET as aiUsageGET } from "../apps/api/app/api/v1/admin/ai/usage/route"
import { GET as aiUsageSummaryGET } from "../apps/api/app/api/v1/admin/ai/usage/summary/route"
import { GET as mcpUsageGET } from "../apps/api/app/api/v1/admin/mcp/usage/route"
import { GET as mcpUsageSummaryGET } from "../apps/api/app/api/v1/admin/mcp/usage/summary/route"
import { GET as auditLogsGET } from "../apps/api/app/api/v1/admin/audit-logs/route"
import { GET as auditLogsExportGET } from "../apps/api/app/api/v1/admin/audit-logs/export/route"
import { GET as submissionsGET } from "../apps/api/app/api/v1/admin/submissions/route"
import { PATCH as providerPATCH } from "../apps/api/app/api/v1/admin/billing/providers/[provider]/route"

const repoRoot = path.resolve(import.meta.dirname, "..")

function get(url: string) {
  return new NextRequest(url, { method: "GET" })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("SRC-119 usage period", () => {
  const base = "http://localhost:3001/api/v1/admin/usage?userId=u1"

  it("422s on an unparseable period with the single validation shape", async () => {
    const res = await usageGET(get(`${base}&period=not-a-date`))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: "Invalid period date" })
    expect(mockGetUsage).not.toHaveBeenCalled()
  })

  it("accepts a YYYY-MM period and passes a real Date to the service", async () => {
    const res = await usageGET(get(`${base}&period=2026-11`))
    expect(res.status).toBe(200)
    expect(mockGetUsage).toHaveBeenCalledWith(
      mockSession,
      "u1",
      undefined,
      new Date("2026-11-01T00:00:00.000Z")
    )
  })

  it("accepts a YYYY-MM-DD period", async () => {
    const res = await usageGET(get(`${base}&period=2026-11-05`))
    expect(res.status).toBe(200)
    expect(mockGetUsage).toHaveBeenCalledWith(
      mockSession,
      "u1",
      undefined,
      new Date("2026-11-05T00:00:00.000Z")
    )
  })
})

describe("SRC-231 date filters are 422s, not silent drops", () => {
  const cases = [
    {
      name: "AI usage",
      url: "http://localhost:3001/api/v1/admin/ai/usage",
      fn: aiUsageGET,
      service: mockListAiUsage,
    },
    {
      name: "MCP usage",
      url: "http://localhost:3001/api/v1/admin/mcp/usage",
      fn: mcpUsageGET,
      service: mockListMcpUsage,
    },
    {
      name: "audit logs",
      url: "http://localhost:3001/api/v1/admin/audit-logs",
      fn: auditLogsGET,
      service: mockListAuditLogs,
    },
    {
      name: "platform submissions",
      url: "http://localhost:3001/api/v1/admin/submissions",
      fn: submissionsGET,
      service: mockListPlatformSubmissions,
    },
  ] as const

  for (const { name, url, fn, service } of cases) {
    it(`${name}: ?from=not-a-date → 422 "Invalid from date"`, async () => {
      const res = await fn(get(`${url}?from=not-a-date`))
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ error: "Invalid from date" })
      expect(service).not.toHaveBeenCalled()
    })

    it(`${name}: ?to=garbage → 422 "Invalid to date"`, async () => {
      const res = await fn(get(`${url}?to=garbage`))
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ error: "Invalid to date" })
      expect(service).not.toHaveBeenCalled()
    })

    it(`${name}: valid from/to reach the service`, async () => {
      const res = await fn(get(`${url}?from=2026-01-01&to=2026-11-24`))
      expect(res.status).toBe(200)
      expect(service).toHaveBeenCalledTimes(1)
      expect(service.mock.calls[0][1]).toMatchObject({
        from: "2026-01-01",
        to: "2026-11-24",
      })
    })
  }
})

describe("SRC-231 date filters on the summary + export routes", () => {
  // The audit-logs export and the AI/MCP usage summaries take the
  // same `from`/`to` filters through the same silently-dropping
  // builders, and had no route-level guard until the Wave 4
  // replacement pass.
  const cases = [
    {
      name: "AI usage summary",
      url: "http://localhost:3001/api/v1/admin/ai/usage/summary",
      fn: aiUsageSummaryGET,
      service: mockGetAiUsageSummary,
    },
    {
      name: "MCP usage summary",
      url: "http://localhost:3001/api/v1/admin/mcp/usage/summary",
      fn: mcpUsageSummaryGET,
      service: mockGetMcpUsageSummary,
    },
    {
      name: "audit logs export",
      url: "http://localhost:3001/api/v1/admin/audit-logs/export",
      fn: auditLogsExportGET,
      service: mockExportAuditLogs,
    },
  ] as const

  for (const { name, url, fn, service } of cases) {
    it(`${name}: ?from=not-a-date → 422 "Invalid from date"`, async () => {
      const res = await fn(get(`${url}?from=not-a-date`))
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ error: "Invalid from date" })
      expect(service).not.toHaveBeenCalled()
    })

    it(`${name}: ?to=garbage → 422 "Invalid to date"`, async () => {
      const res = await fn(get(`${url}?to=garbage`))
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ error: "Invalid to date" })
      expect(service).not.toHaveBeenCalled()
    })

    it(`${name}: valid from/to reach the service`, async () => {
      const res = await fn(get(`${url}?from=2026-01-01&to=2026-11-24`))
      expect(res.status).toBe(200)
      expect(service).toHaveBeenCalledTimes(1)
      expect(service.mock.calls[0][1]).toMatchObject({
        from: "2026-01-01",
        to: "2026-11-24",
      })
    })
  }
})

describe("SRC-112 billing provider parsing", () => {
  const body = { isEnabled: false, reason: "test" }

  function patch(provider: string, payload: unknown) {
    return new NextRequest(
      `http://localhost:3001/api/v1/admin/billing/providers/${provider}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    )
  }

  it("accepts a lowercase provider name and passes the enum value", async () => {
    const res = await providerPATCH(patch("stripe", body), {
      params: Promise.resolve({ provider: "stripe" }),
    })
    expect(res.status).toBe(200)
    expect(mockSetProviderConfig).toHaveBeenCalledWith(
      mockSession,
      "STRIPE",
      body
    )
  })

  it("404s on an unknown provider without calling the service", async () => {
    const res = await providerPATCH(patch("nope", body), {
      params: Promise.resolve({ provider: "nope" }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: "Unknown billing provider: nope",
    })
    expect(mockSetProviderConfig).not.toHaveBeenCalled()
  })

  it("still 422s on an invalid body", async () => {
    const res = await providerPATCH(patch("stripe", {}), {
      params: Promise.resolve({ provider: "stripe" }),
    })
    expect(res.status).toBe(422)
    expect(mockSetProviderConfig).not.toHaveBeenCalled()
  })

  it("no route imports the database package at runtime (health route excepted)", () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name === "route.ts") files.push(full)
      }
    }
    walk(path.join(repoRoot, "apps/api/app/api"))
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8")
      return (
        src.includes('from "@sendcms/database"') &&
        // PRF-002 (Wave 11): the DB ping lives on the deep health
        // route now; both health routes may import the database.
        !f.endsWith("apps/api/app/api/health/route.ts") &&
        !f.endsWith("apps/api/app/api/health/deep/route.ts")
      )
    })
    expect(offenders).toEqual([])
  })
})
