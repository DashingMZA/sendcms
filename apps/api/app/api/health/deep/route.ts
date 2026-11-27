import { getLastCronRun } from "@sendcms/cron"
import { pingDatabase } from "@sendcms/database"
import { handleApiError, ok } from "@sendcms/api-client"

// PRF-002 (Phase 16, Wave 11): the deep health check — the old
// `/api/health` body, moved here unchanged. This is the endpoint
// that proves the database is reachable (and surfaces the last
// scheduled email run, EML-064); it is intentionally NOT the
// liveness endpoint — use `/api/health` for load-balancer checks so
// a slow or dead database cannot fail or slow liveness, and use
// this route (or a slower cadence) where the DB signal matters.
// docker-compose and render.yaml healthchecks point here.
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const health = await pingDatabase()
    // EML-064: the last scheduled email run, when this instance has
    // made one (null before the first run, or on an instance that
    // never ran the cron — serverless isolates keep their own copy;
    // the structured `cron:email-outbox` log line is the durable
    // record, this is the cheap status read).
    return ok({ ...health, lastCronRun: getLastCronRun() })
  } catch (err) {
    return handleApiError(err)
  }
}
