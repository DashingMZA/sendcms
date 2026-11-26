import { getLastCronRun } from "@sendcms/cron"
import { pingDatabase } from "@sendcms/database"
import { handleApiError, ok } from "@sendcms/api-client"

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
