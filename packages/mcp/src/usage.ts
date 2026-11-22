import { db } from "@sendcms/database"
import type { McpUsageStatus } from "@sendcms/database"
import { createLogger } from "@sendcms/observability"
import type { McpAuthContext } from "./auth"

const logger = createLogger("mcp")

// One row per executed MCP tool call — the analytics source. Best
// effort: a failed usage write must never fail the tool call itself.
// Never contains request arguments or results, only the tool name,
// the outcome, and the duration.
export async function recordMcpUsage(input: {
  apiKeyId: string
  userId: string
  tool: string
  status: McpUsageStatus
  durationMs?: number | null
}): Promise<void> {
  try {
    await db.mcpUsageRecord.create({
      data: {
        apiKeyId: input.apiKeyId,
        userId: input.userId,
        tool: input.tool,
        status: input.status,
        durationMs: input.durationMs ?? null,
      },
    })
  } catch (err) {
    logger.error("mcp usage record failed", {
      error: err,
      apiKeyId: input.apiKeyId,
      userId: input.userId,
      tool: input.tool,
    })
  }
}

export type McpCallOutcome = {
  tool: string
  ok: boolean
}

// Derives the outcome of every tools/call in a JSON-RPC request from
// the matching response (pure function, unit-tested). Requests and
// responses are matched by `id`. A call counts as SUCCESS when its
// response carries a `result` without `isError`; anything else — a
// JSON-RPC `error`, or no matching response at all — is not recorded,
// because the outcome cannot be established. Only tools/call entries
// are returned; initialize / tools/list / notifications are not
// usage.
export function extractMcpCallOutcomes(
  requestBody: unknown,
  responseBody: unknown
): McpCallOutcome[] {
  const requests = Array.isArray(requestBody) ? requestBody : [requestBody]
  const responses = Array.isArray(responseBody)
    ? responseBody
    : responseBody !== null && typeof responseBody === "object"
      ? [responseBody]
      : []
  const byId = new Map<unknown, Record<string, unknown>>()
  for (const response of responses) {
    if (response !== null && typeof response === "object") {
      byId.set(
        (response as Record<string, unknown>).id,
        response as Record<string, unknown>
      )
    }
  }
  const outcomes: McpCallOutcome[] = []
  for (const request of requests) {
    if (request === null || typeof request !== "object") continue
    const req = request as Record<string, unknown>
    if (req.method !== "tools/call") continue
    const params = req.params
    const tool =
      params !== null && typeof params === "object"
        ? (params as Record<string, unknown>).name
        : undefined
    if (typeof tool !== "string" || !tool) continue
    const response = byId.get(req.id)
    if (!response) continue
    if ("error" in response) {
      outcomes.push({ tool, ok: false })
      continue
    }
    const result = response.result
    const isError =
      result !== null &&
      typeof result === "object" &&
      (result as Record<string, unknown>).isError === true
    outcomes.push({ tool, ok: !isError })
  }
  return outcomes
}

// Records every executed tools/call from one transport round-trip.
// The route calls this after handleRequest returns, from the cloned
// response — the original response is returned untouched. Never
// throws; a refused-before-execution call never reaches here, so it
// is never recorded.
export async function recordMcpCallOutcomes(
  auth: McpAuthContext,
  requestBody: unknown,
  responseBody: unknown,
  durationMs: number
): Promise<void> {
  const outcomes = extractMcpCallOutcomes(requestBody, responseBody)
  for (const outcome of outcomes) {
    await recordMcpUsage({
      apiKeyId: auth.keyId,
      userId: auth.userId,
      tool: outcome.tool,
      status: outcome.ok ? "SUCCESS" : "FAILED",
      durationMs,
    })
  }
}
