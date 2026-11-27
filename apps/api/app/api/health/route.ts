import { ok } from "@sendcms/api-client"

// PRF-002 (Phase 16, Wave 11): cheap liveness endpoint for
// load-balancer / orchestrator checks. The old `/api/health` did a
// live database ping on every call — the largest server-side cost on
// the endpoint, and unnecessary for "is the process up?". This route
// touches no database, no service, and no I/O at all: it answers
// from memory only, so a dead database (or a slow one) cannot make
// liveness fail or slow. The DB-aware check lives on
// `/api/health/deep` (same shape as the old `/api/health`, including
// `lastCronRun`); point healthchecks that must prove the database is
// reachable at `/api/health/deep` instead — docker-compose and
// render.yaml already do. The 500 ms target itself cannot be judged
// from the sandbox (see the finding); the deliverable here is the
// cheap endpoint, not a latency claim.
//
// Keep this file free of `@sendcms/database` imports: the
// route-import test (`tests/admin-date-filters.test.ts`) forbids them
// everywhere except the health routes, and this route's whole point
// is not needing the database.
export const dynamic = "force-dynamic"

export async function GET() {
  return ok({
    status: "ok",
    uptimeSeconds: Math.floor(process.uptime()),
  })
}
