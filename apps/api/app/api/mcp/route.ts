import { NextResponse } from "next/server"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  checkMcpAccess,
  checkMcpRateLimit,
  createMcpServer,
  recordMcpCallOutcomes,
  resolveMcpAuth,
} from "@sendcms/mcp"
import { handleApiError } from "@sendcms/api-client"

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

    const contentLength = req.headers.get("content-length")
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: "Request body too large." },
        { status: 413 }
      )
    }
    const body = await req.json().catch(() => null)
    if (body === null || typeof body !== "object") {
      return NextResponse.json(
        { error: "Expected a JSON-RPC request body." },
        { status: 400 }
      )
    }

    const method = (body as { method?: string }).method
    const started = Date.now()

    if (method === "tools/call") {
      const params = (body as { params?: unknown }).params
      const toolName =
        params !== null && typeof params === "object"
          ? (params as { name?: unknown }).name
          : undefined
      if (typeof toolName !== "string" || !toolName) {
        return NextResponse.json(
          { error: "A tool name is required." },
          { status: 400 }
        )
      }
      // Refusals happen BEFORE execution: no quota consumed, no usage
      // row written. The allowlist check 404s with the same "Tool X
      // not found" a READ key gets for a mutation.
      const access = await checkMcpAccess({ auth, tool: toolName })
      // Rate-limit tool calls only — initialize / tools/list are cheap
      // metadata and do not count against the key's budget.
      await checkMcpRateLimit(auth.keyId, {
        minuteLimit: access.minuteLimit,
        hourLimit: access.hourLimit,
      })
      const server = createMcpServer({
        ...auth,
        allowedTools: access.allowedTools,
      })
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      await server.connect(transport)
      const response = await transport.handleRequest(req, { parsedBody: body })
      // Usage is recorded from the CLONED response — the original is
      // returned untouched. Awaiting one indexed insert per call keeps
      // the record durable (a fire-and-forget write can be cut off
      // when a serverless function returns).
      const responseBody = await response
        .clone()
        .json()
        .catch(() => null)
      await recordMcpCallOutcomes(
        auth,
        body,
        responseBody,
        Date.now() - started
      )
      return response
    }

    // initialize / tools/list / ping: the access check still applies
    // (kill-switch, suspension, per-user disable), and the allowlist
    // filters what tools/list shows — a disallowed tool is never
    // listed, so a client cannot call what it may not do.
    const access = await checkMcpAccess({ auth })
    const server = createMcpServer({
      ...auth,
      allowedTools: access.allowedTools,
    })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    return transport.handleRequest(req, { parsedBody: body })
  } catch (err) {
    // ApiError (e.g. the 503 from the kill-switch, the 403 for a
    // suspended owner, the 404 for a disallowed tool, the 429 from
    // the rate limiter) carries its status; anything else is logged
    // and answered as a plain 500.
    return handleApiError(err)
  }
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
