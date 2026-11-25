import { NextResponse } from "next/server"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  checkMcpAccess,
  checkMcpRateLimit,
  createMcpServer,
  recordMcpCallOutcomes,
  resolveMcpAuth,
  type McpAuthContext,
} from "@sendcms/mcp"
import { ApiError, handleApiError } from "@sendcms/api-client"

// MCP endpoint (ADR 0009): Streamable HTTP, stateless, JSON responses.
// Auth is a per-user API key (Bearer) — the dashboard's session cookie
// does not work here, because MCP clients are not browsers. The key
// resolves to a userId + scope, and every tool runs through the same
// *ForUser service functions as the REST routes, so a key can never see
// another owner's data. POST only — GET/DELETE have no meaning in
// stateless mode (no sessions, no standalone stream).
//
// Admin MCP controls (Phase 6) are enforced HERE, in the service, not
// only in the admin UI: every request goes through checkMcpAccess
// (global kill-switch → suspended owner → per-user disable → tool
// allowlist) before anything is executed, tools/call is rate-limited
// with the owner's effective limits, and every executed call writes
// a usage row. A call refused before execution consumes no quota and
// writes no usage row.
export const dynamic = "force-dynamic"

// The transport reads at most 4 MiB itself; mirror that bound here
// since this route parses the body before handing it over.
const MAX_BODY_BYTES = 4 * 1024 * 1024

function unauthorized() {
  return NextResponse.json(
    {
      error:
        "Unauthorized — pass a valid API key as a Bearer token (create one at /dashboard/api-keys).",
    },
    { status: 401 }
  )
}

export async function POST(req: Request) {
  try {
    const auth = await resolveMcpAuth(req)
    if (!auth) return unauthorized()
    const body = await readMcpBody(req)
    if (body === null || typeof body !== "object") {
      throw new ApiError("Expected a JSON-RPC request body.", 400)
    }
    const method = (body as { method?: string }).method
    if (method === "tools/call") {
      // await: a bare return would let its rejection skip this catch.
      return await handleToolsCall(req, auth, body as Record<string, unknown>)
    }
    // initialize / tools/list / ping: the access check still applies
    // (kill-switch, suspension, per-user disable), and the allowlist
    // filters what tools/list shows — a disallowed tool is never
    // listed, so a client cannot call what it may not do.
    const access = await checkMcpAccess({ auth })
    return await runMcpRequest(req, auth, body, access.allowedTools)
  } catch (err) {
    // ApiError (e.g. the 503 from the kill-switch, the 403 for a
    // suspended owner, the 404 for a disallowed tool, the 429 from
    // the rate limiter) carries its status; anything else is logged
    // and answered as a plain 500.
    return handleApiError(err)
  }
}

// Reads + parses the JSON-RPC body, enforcing the 4 MiB bound on the
// bytes actually read — AIM-009: the old Content-Length guard alone
// let chunked oversized bodies through to the transport, where they
// surfaced as a 400 / -32700 instead of a 413.
async function readMcpBody(req: Request): Promise<unknown> {
  // Cheap fast path: a declared Content-Length over the bound is
  // rejected without reading. Chunked bodies declare no length, so
  // the bound is enforced again on the bytes actually read below.
  const contentLength = req.headers.get("content-length")
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    throw new ApiError("Request body too large.", 413)
  }
  const text = await req.text()
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new ApiError("Request body too large.", 413)
  }
  try {
    return text ? JSON.parse(text) : null
  } catch {
    throw new ApiError("Expected a JSON-RPC request body.", 400)
  }
}

// tools/call: the tool name is required, refusals happen BEFORE
// execution (no quota consumed, no usage row written), and the
// allowlist check 404s with the same "Tool X not found" a READ key
// gets for a mutation. Usage is recorded from the CLONED response —
// the original is returned untouched.
async function handleToolsCall(
  req: Request,
  auth: McpAuthContext,
  body: Record<string, unknown>
): Promise<Response> {
  const params = body.params
  const toolName =
    params !== null && typeof params === "object"
      ? (params as { name?: unknown }).name
      : undefined
  if (typeof toolName !== "string" || !toolName) {
    throw new ApiError("A tool name is required.", 400)
  }
  const access = await checkMcpAccess({ auth, tool: toolName })
  // Rate-limit tool calls only — initialize / tools/list are cheap
  // metadata and do not count against the key's budget.
  await checkMcpRateLimit(auth.keyId, {
    minuteLimit: access.minuteLimit,
    hourLimit: access.hourLimit,
  })
  const started = Date.now()
  const response = await runMcpRequest(req, auth, body, access.allowedTools)
  // Awaiting one indexed insert per call keeps the record durable (a
  // fire-and-forget write can be cut off when a serverless function
  // returns).
  const responseBody = await response
    .clone()
    .json()
    .catch(() => null)
  await recordMcpCallOutcomes(auth, body, responseBody, Date.now() - started)
  return response
}

// Shared transport run: build the server with the caller's allowlist
// and hand the parsed body to the Streamable HTTP transport.
async function runMcpRequest(
  req: Request,
  auth: McpAuthContext,
  body: unknown,
  allowedTools: string[] | null
): Promise<Response> {
  const server = createMcpServer({ ...auth, allowedTools })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  return transport.handleRequest(req, { parsedBody: body })
}

export async function GET() {
  return NextResponse.json(
    { error: "This endpoint accepts POST only (MCP Streamable HTTP)." },
    { status: 405 }
  )
}

export async function DELETE() {
  return NextResponse.json(
    { error: "This endpoint accepts POST only (MCP Streamable HTTP)." },
    { status: 405 }
  )
}
