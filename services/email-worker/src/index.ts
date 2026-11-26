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

// SRC-320: fail fast when DATABASE_URL is unset. Without it the
// database singleton is built with `undefined` and pg falls back to
// localhost:5432 (see ./env) — the worker would then poll forever
// against a database that is not there, reporting `down` instead of
// refusing to start. The check runs after ./env loads the workspace
// .env files, and before the first poll.
if (!process.env.DATABASE_URL) {
  logger.error("DATABASE_URL is not set — the email worker cannot start.")
  process.exit(1)
}

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
