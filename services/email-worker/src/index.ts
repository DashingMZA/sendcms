// Email worker entry point (Phase 9). Run with
// `pnpm --filter @sendcms/email-worker start` (or `dev` for watch
// mode). Reads DATABASE_URL + the email provider env (RESEND_API_KEY /
// SMTP_*) from the environment; in dev the workspace root .env is
// loaded by ./env (the first import — it must run before the database
// singleton is created). Exits 0 on SIGTERM/SIGINT after a graceful
// stop.
import "./env"
import { createLogger } from "@sendcms/observability"
import { createEmailWorker } from "./worker"

const logger = createLogger("email-worker")

const worker = createEmailWorker()
await worker.start()
logger.info(
  `health on :${worker.getPort()}, polling every ${process.env.WORKER_POLL_INTERVAL_MS ?? 30_000}ms`
)

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} — stopping gracefully…`)
  await worker.stop()
  logger.info("stopped")
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
