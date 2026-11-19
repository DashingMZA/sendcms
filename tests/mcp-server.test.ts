// MCP server gates (Phase 11): protocol-level tests over an in-memory
// transport — a real MCP client lists the tools and calls them against
// mocked services.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

const mockDb = vi.hoisted(() => ({
  domain: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
  form: { count: vi.fn(), findMany: vi.fn() },
  submission: { count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  apiKeyRateLimit: { findUnique: vi.fn(), upsert: vi.fn() },
  auditLog: { create: vi.fn() },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

import { checkMcpRateLimit, createMcpServer } from "@sendcms/mcp"
import type { McpAuthContext } from "@sendcms/mcp"

const fullAuth: McpAuthContext = {
  keyId: "key-1",
  userId: "user-1",
  scope: "FULL",
}
const readAuth: McpAuthContext = {
  keyId: "key-2",
  userId: "user-1",
  scope: "READ",
}

const ALL_TOOLS = [
  "list_domains",
  "get_domain",
  "create_domain",
  "verify_domain",
  "delete_domain",
  "list_forms",
  "get_form",
  "create_form",
  "update_form",
  "delete_form",
  "list_submissions",
  "get_submission",
  "update_submission",
  "bulk_update_submissions",
  "delete_submission",
  "get_overview",
  "get_analytics",
  "list_email_jobs",
  "send_test_email",
]

const READ_TOOLS = [
  "list_domains",
  "get_domain",
  "list_forms",
  "get_form",
  "list_submissions",
  "get_submission",
  "get_overview",
  "get_analytics",
  "list_email_jobs",
]

async function connectClient(auth: McpAuthContext) {
  const server = createMcpServer(auth)
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  )
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}

function toolText(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] })
    .content
  return content[0].text
}

let connected: {
  client: Client
  server: ReturnType<typeof createMcpServer>
} | null = null

afterEach(async () => {
  if (connected) {
    await connected.client.close().catch(() => {})
    await connected.server.close().catch(() => {})
    connected = null
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.domain.count.mockResolvedValue(2)
  mockDb.form.count.mockResolvedValue(1)
  mockDb.submission.count.mockResolvedValue(3)
  mockDb.submission.findMany.mockResolvedValue([])
  mockDb.submission.groupBy.mockResolvedValue([])
  mockDb.form.findMany.mockResolvedValue([])
})

describe("tools/list", () => {
  it("a FULL key sees all 19 tools", async () => {
    connected = await connectClient(fullAuth)
    const { tools } = await connected.client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort())
  })

  it("a READ key sees only the 9 read-only tools", async () => {
    connected = await connectClient(readAuth)
    const { tools } = await connected.client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort())
  })
})

describe("tools/call", () => {
  it("list_domains returns the owner's domains as JSON", async () => {
    const domain = {
      id: "dom-1",
      name: "example.com",
      domain: "example.com",
      status: "VERIFIED",
      ownerId: "user-1",
      verifications: [],
      _count: { formLinks: 1 },
    }
    mockDb.domain.findMany.mockResolvedValue([domain])
    connected = await connectClient(fullAuth)
    const result = await connected.client.callTool({
      name: "list_domains",
      arguments: {},
    })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(toolText(result))
    expect(parsed).toHaveLength(1)
    expect(parsed[0].domain).toBe("example.com")
  })

  it("get_overview returns the mocked counts", async () => {
    connected = await connectClient(fullAuth)
    const result = await connected.client.callTool({
      name: "get_overview",
      arguments: {},
    })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(toolText(result))
    expect(parsed.domainCount).toBe(2)
    expect(parsed.formCount).toBe(1)
    expect(parsed.submissionCount).toBe(3)
  })

  it("get_analytics returns the mocked breakdown", async () => {
    connected = await connectClient(fullAuth)
    const result = await connected.client.callTool({
      name: "get_analytics",
      arguments: { days: 7 },
    })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(toolText(result))
    expect(parsed.total).toBe(3)
    expect(parsed.byDay).toHaveLength(7)
  })

  it("get_domain with an unknown id is a tool error, not a crash", async () => {
    mockDb.domain.findFirst.mockResolvedValue(null)
    connected = await connectClient(fullAuth)
    const result = await connected.client.callTool({
      name: "get_domain",
      arguments: { domainId: "nope" },
    })
    expect(result.isError).toBe(true)
    expect(toolText(result)).toContain("Domain not found")
  })

  it("a READ key cannot call a mutation tool", async () => {
    connected = await connectClient(readAuth)
    // The server answers with a tool error, not a crash — the client
    // sees "Tool create_domain not found".
    const result = await connected.client.callTool({
      name: "create_domain",
      arguments: { domain: "example.com" },
    })
    expect(result.isError).toBe(true)
    expect(toolText(result)).toContain("Tool create_domain not found")
  })
})

describe("checkMcpRateLimit", () => {
  it("passes under the limits and upserts the counters", async () => {
    mockDb.apiKeyRateLimit.findUnique.mockResolvedValue(null)
    await checkMcpRateLimit("key-1")
    expect(mockDb.apiKeyRateLimit.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { apiKeyId: "key-1" },
        create: expect.objectContaining({ minuteCount: 1, hourCount: 1 }),
      })
    )
  })

  it("429s past the per-minute limit", async () => {
    const now = new Date()
    const minuteStart = new Date(now)
    minuteStart.setSeconds(0, 0)
    const hourStart = new Date(now)
    hourStart.setMinutes(0, 0, 0)
    mockDb.apiKeyRateLimit.findUnique.mockResolvedValue({
      apiKeyId: "key-1",
      minuteWindowStart: minuteStart,
      minuteCount: 120,
      hourWindowStart: hourStart,
      hourCount: 50,
    })
    await expect(checkMcpRateLimit("key-1")).rejects.toThrowError(
      "Too many MCP requests"
    )
    expect(mockDb.apiKeyRateLimit.upsert).not.toHaveBeenCalled()
  })

  it("429s past the per-hour limit", async () => {
    const now = new Date()
    const minuteStart = new Date(now)
    minuteStart.setSeconds(0, 0)
    const hourStart = new Date(now)
    hourStart.setMinutes(0, 0, 0)
    mockDb.apiKeyRateLimit.findUnique.mockResolvedValue({
      apiKeyId: "key-1",
      minuteWindowStart: minuteStart,
      minuteCount: 1,
      hourWindowStart: hourStart,
      hourCount: 2000,
    })
    await expect(checkMcpRateLimit("key-1")).rejects.toThrowError(
      "Too many MCP requests"
    )
  })
})
