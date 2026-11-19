import { NextResponse } from "next/server"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  checkMcpRateLimit,
  createMcpServer,
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

    // Rate-limit tool calls only — initialize / tools/list are cheap
    // metadata and do not count against the key's budget.
    if ((body as { method?: string }).method === "tools/call") {
      await checkMcpRateLimit(auth.keyId)
    }

    const server = createMcpServer(auth)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    return transport.handleRequest(req, { parsedBody: body })
  } catch (err) {
    // ApiError (e.g. the 429 from the rate limiter) carries its status;
    // anything else is logged and answered as a plain 500.
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
