// MCP route (AIM-009 / SRC-103): auth, body-size enforcement
// including chunked bodies, and the tools/call pre-checks — with the
// @sendcms/mcp service layer mocked, so these tests pin the route's
// own decisions.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockResolveMcpAuth = vi.hoisted(() => vi.fn())
const mockCheckMcpAccess = vi.hoisted(() => vi.fn())
const mockCheckMcpRateLimit = vi.hoisted(() => vi.fn())
const mockCreateMcpServer = vi.hoisted(() => vi.fn())
const mockRecordMcpCallOutcomes = vi.hoisted(() => vi.fn())
vi.mock("@sendcms/mcp", () => ({
  resolveMcpAuth: mockResolveMcpAuth,
  checkMcpAccess: mockCheckMcpAccess,
  checkMcpRateLimit: mockCheckMcpRateLimit,
  createMcpServer: mockCreateMcpServer,
  recordMcpCallOutcomes: mockRecordMcpCallOutcomes,
}))

import { POST } from "../apps/api/app/api/mcp/route"
import { ApiError } from "@sendcms/api-client"

const URL = "http://localhost:3000/api/mcp"
const AUTH = { keyId: "key-1", userId: "user-1", scope: "READ" }
const MAX_BODY_BYTES = 4 * 1024 * 1024

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

// A body sent without a Content-Length — what a chunked transfer
// looks like to the route. Undici streams a ReadableStream body with
// no length header.
function chunkedRequest(body: string) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Request(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test",
    },
    body: stream,
    duplex: "half",
  } as RequestInit)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveMcpAuth.mockResolvedValue(AUTH)
  mockCheckMcpAccess.mockResolvedValue({ allowedTools: [] })
  mockCheckMcpRateLimit.mockResolvedValue(undefined)
})

describe("POST /api/mcp", () => {
  it("returns 401 when no API key resolves", async () => {
    mockResolveMcpAuth.mockResolvedValueOnce(null)
    const res = await POST(
      jsonRequest({ jsonrpc: "2.0", method: "ping", id: 1 })
    )
    expect(res.status).toBe(401)
  })

  it("returns 413 when Content-Length exceeds 4 MiB", async () => {
    const res = await POST(
      jsonRequest("x".repeat(MAX_BODY_BYTES + 1), {
        "Content-Length": String(MAX_BODY_BYTES + 1),
      })
    )
    expect(res.status).toBe(413)
    expect((await res.json()).error).toContain("too large")
    expect(mockCheckMcpAccess).not.toHaveBeenCalled()
  })

  // AIM-009: the old Content-Length guard alone let a chunked
  // oversized body through to the transport, where it surfaced as a
  // 400 / -32700 instead of a 413.
  it("returns 413 for a chunked body over 4 MiB with no Content-Length", async () => {
    const req = chunkedRequest("x".repeat(MAX_BODY_BYTES + 1))
    expect(req.headers.get("content-length")).toBeNull()
    const res = await POST(req)
    expect(res.status).toBe(413)
    expect((await res.json()).error).toContain("too large")
    expect(mockCheckMcpAccess).not.toHaveBeenCalled()
  })

  it("lets a chunked body under the limit through to the access check", async () => {
    mockCheckMcpAccess.mockRejectedValueOnce(
      new ApiError("MCP is temporarily disabled.", 503)
    )
    const res = await POST(
      chunkedRequest(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }))
    )
    // 503 from the access check proves the body passed the size
    // guard and reached the service layer.
    expect(res.status).toBe(503)
    expect(mockCheckMcpAccess).toHaveBeenCalledTimes(1)
  })

  it("returns 400 for malformed JSON", async () => {
    const res = await POST(jsonRequest("{not json"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("JSON-RPC")
  })

  it("returns 400 for a JSON null body", async () => {
    const res = await POST(jsonRequest("null"))
    expect(res.status).toBe(400)
  })

  it("returns 400 when tools/call has no tool name", async () => {
    const res = await POST(
      jsonRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {},
        id: 1,
      })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("tool name")
    expect(mockCheckMcpAccess).not.toHaveBeenCalled()
  })
})
