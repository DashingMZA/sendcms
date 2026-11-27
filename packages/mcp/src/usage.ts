import { randomUUID } from "node:crypto"
import { Prisma, db } from "@sendcms/database"
import type { McpUsageStatus } from "@sendcms/database"
import { createLogger } from "@sendcms/observability"
import type { McpAuthContext } from "./auth"

const logger = createLogger("mcp")

// One row per executed MCP tool call — the analytics source. Best
// effort: a failed usage write must never fail the tool call itself.
// Never contains request arguments or results, only the tool name,
// the outcome, and the duration.
//
// DB-003: every row carries an `idempotencyKey` (unique). The key
// is deterministic per client request — `mcp:<apiKeyId>:<jsonrpc
// id>:<tool>` (plus the batch index when one request carries the
// same tool twice) — so a retried MCP call (client retry, endpoint
// retry, double delivery) reuses the same key and hits the unique
// constraint instead of double-counting usage. A fresh random key
// would NOT dedupe a retry (each attempt would mint a new one), so
// callers pass the key for the request they are recording; a direct
// caller that passes none gets a fresh random one (no dedupe, but
// always a recorded key). JSON-RPC ids are unique per outstanding
// request in a session (the client matches responses by id), so a
// repeated id for the same tool IS a retry — and the failure mode
// of a pathological id-reusing client is one undercounted row,
// never a double-counted one.
export async function recordMcpUsage(input: {
  apiKeyId: string
  userId: string
  tool: string
  status: McpUsageStatus
  durationMs?: number | null
  idempotencyKey?: string
}): Promise<void> {
  try {
    await db.mcpUsageRecord.create({
      data: {
        apiKeyId: input.apiKeyId,
        userId: input.userId,
        tool: input.tool,
        status: input.status,
        durationMs: input.durationMs ?? null,
        idempotencyKey: input.idempotencyKey ?? randomUUID(),
      },
    })
  } catch (err) {
    // DB-003: a P2002 on the idempotency key is a retried call —
    // the row already exists, so there is nothing to record and
    // nothing to log. Any other failure is logged, and the tool
    // call itself is unaffected.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return
    }
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

type McpCallOutcomeWithId = McpCallOutcome & { requestId: unknown }

// The id-carrying form of the outcome derivation. `requestId` is
// the JSON-RPC request id the outcome was matched on — it is what
// the usage idempotency key is built from (DB-003). Kept separate
// from `extractMcpCallOutcomes` so that function's public contract
// ({tool, ok} only) and its tests do not change.
function extractMcpCallOutcomesWithIds(
  requestBody: unknown,
  responseBody: unknown
): McpCallOutcomeWithId[] {
  const requests = Array.isArray(requestBody) ? requestBody : [requestBody]
  const responses = Array.isArray(responseBody)
    ? responseBody
    : responseBody !== null && typeof responseBody === "object"
      ? [responseBody]
      : []
  const byId = new Map<unknown, Record<string, unknown>>()
  for (const response of responses) {
    if (response !== null && typeof response === "object") {
      const id = (response as Record<string, unknown>).id
      // A response with no id is a notification response — it can
      // never be matched to a request, so it must not sit in the
      // map under the `undefined` key (that would falsely match a
      // notification request, which also has no id).
      if (id === undefined) continue
      byId.set(id, response as Record<string, unknown>)
    }
  }
  const outcomes: McpCallOutcomeWithId[] = []
  for (const request of requests) {
    if (request === null || typeof request !== "object") continue
    const req = request as Record<string, unknown>
    if (req.method !== "tools/call") continue
    // A notification request (no id) expects no response by design
    // and is never recorded — checked before the lookup, not only
    // in the no-response branch.
    if (req.id === undefined) continue
    const params = req.params
    const tool =
      params !== null && typeof params === "object"
        ? (params as Record<string, unknown>).name
        : undefined
    if (typeof tool !== "string" || !tool) continue
    const response = byId.get(req.id)
    // SRC-332: no matching response — the call was executed but
    // never answered (crash/timeout). Recorded as FAILED, not
    // dropped: dropping it hid server failures from analytics.
    if (!response) {
      outcomes.push({ tool, ok: false, requestId: req.id })
      continue
    }
    if ("error" in response) {
      outcomes.push({ tool, ok: false, requestId: req.id })
      continue
    }
    const result = response.result
    const isError =
      result !== null &&
      typeof result === "object" &&
      (result as Record<string, unknown>).isError === true
    outcomes.push({ tool, ok: !isError, requestId: req.id })
  }
  return outcomes
}

// Derives the outcome of every tools/call in a JSON-RPC request from
// the matching response (pure function, unit-tested). Requests and
// responses are matched by `id`. A call counts as SUCCESS when its
// response carries a `result` without `isError`; a JSON-RPC `error`
// counts as FAILED. A call with NO matching response at all is
// recorded as FAILED too (SRC-332): the old code dropped it
// entirely, so server crashes/timeouts were invisible in usage
// analytics — a tools/call that was executed but never answered is
// a failed execution, not a non-event. Only tools/call entries are
// returned; initialize / tools/list / notifications are not usage.
export function extractMcpCallOutcomes(
  requestBody: unknown,
  responseBody: unknown
): McpCallOutcome[] {
  return extractMcpCallOutcomesWithIds(requestBody, responseBody).map(
    ({ tool, ok }) => ({ tool, ok })
  )
}

// Records every executed tools/call from one transport round-trip.
// The route calls this after handleRequest returns, from the cloned
// response — the original response is returned untouched. Never
// throws; a refused-before-execution call never reaches here, so it
// is never recorded.
// SRC-332: the round-trip duration is measured at the transport
// level, so one duration cannot describe N batched calls. It is
// split evenly across the outcomes (remainder to the first) — an
// approximation, labelled as such here, so per-call durations sum
// back to the measured round-trip instead of each row claiming the
// whole trip.
export async function recordMcpCallOutcomes(
  auth: McpAuthContext,
  requestBody: unknown,
  responseBody: unknown,
  durationMs: number
): Promise<void> {
  const outcomes = extractMcpCallOutcomesWithIds(requestBody, responseBody)
  if (outcomes.length === 0) return
  const base = Math.floor(durationMs / outcomes.length)
  const remainder = durationMs - base * outcomes.length
  // DB-047: one `createMany` for the batch instead of one sequential
  // `recordMcpUsage` insert per tool call. `skipDuplicates` keeps the
  // DB-003 dedupe (the `idempotencyKey` unique index drops the retried
  // rows instead of double-counting them); a failed batch is logged,
  // never thrown — a usage write must never fail the tool call.
  try {
    await db.mcpUsageRecord.createMany({
      data: outcomes.map((outcome, i) => ({
        apiKeyId: auth.keyId,
        userId: auth.userId,
        tool: outcome.tool,
        status: outcome.ok ? "SUCCESS" : "FAILED",
        durationMs: base + (i === 0 ? remainder : 0),
        // DB-003: the idempotency key is the client request identity —
        // a retried call (same JSON-RPC id, same tool) reuses the key
        // and dedupes instead of double-counting. The batch index
        // disambiguates one request carrying the same tool twice.
        idempotencyKey: `mcp:${auth.keyId}:${String(outcome.requestId)}:${outcome.tool}:${i}`,
      })),
      skipDuplicates: true,
    })
  } catch (err) {
    logger.error("mcp usage batch record failed", {
      error: err,
      apiKeyId: auth.keyId,
      userId: auth.userId,
      count: outcomes.length,
    })
  }
}
