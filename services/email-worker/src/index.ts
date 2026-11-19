// Email worker entry point (Phase 9). Run with
// `pnpm --filter @sendcms/email-worker start` (or `dev` for watch
// mode). Reads DATABASE_URL + the email provider env (RESEND_API_KEY /
// SMTP_*) from the environment; in dev it also loads the workspace root
// .env when present. Exits 0 on SIGTERM/SIGINT after a graceful stop.
import { config as loadEnv } from "dotenv"
import { createLogger } from "@sendcms/observability"
import { createEmailWorker } from "./worker"

const logger = createLogger("email-worker")

// Dev convenience: the workspace root .env, when it exists. A missing
// file is not an error — production sets env vars directly, and
// dotenv.config() is a no-op without the file. Both paths are tried
// because the working directory depends on how the worker is launched
// (pnpm --filter runs in the package dir; a direct tsx call runs in
// the workspace root).
loadEnv({ path: "../../.env" })
loadEnv({ path: ".env" })

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
