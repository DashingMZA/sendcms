import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createLogger } from "@sendcms/observability"

const logger = createLogger("cron:heartbeat")

// PRF-018: dead-man's-switch ping for the scheduled email-outbox
// drain. A missed ping tells the external monitor the cron (or the
// worker) stopped running — the platform itself cannot notice its own
// scheduler going silent. The URL is owner-configured: env
// `CRON_HEARTBEAT_URL` first, `config/config.json`
// `monitoring.cronHeartbeatUrl` second. With neither set the ping is
// a no-op — the monitor itself is owner-side (uptime checks on the
// six hosts + an alert channel; see the Wave 11 report for the exact
// steps). The ping never throws and never blocks a run: a 5 s
// timeout bounds it, and a failed ping is one warn line, never a
// failed cron run or poll.

export const CRON_HEARTBEAT_TIMEOUT_MS = 5_000

const CRON_HEARTBEAT_CONFIG_CACHE_TTL_MS = 60_000

// The workspace-root walk mirrors the config readers in
// @sendcms/security (rate-limit.ts / step-up.ts) and @sendcms/plans:
// pnpm-workspace.yaml is the marker, resolved from the working
// directory first and from this module file second.
function findWorkspaceRoot(startDir: string): string | null {
  let dir = startDir
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const moduleDir = dirname(fileURLToPath(import.meta.url))

function resolveConfigPath(): string | null {
  for (const startDir of [process.cwd(), moduleDir]) {
    const root = findWorkspaceRoot(startDir)
    if (!root) continue
    const path = join(root, "config", "config.json")
    if (existsSync(path)) return path
  }
  return null
}

type CronHeartbeatConfigCache = {
  url: string | null
  loadedAt: number
}

let configCache: CronHeartbeatConfigCache | null = null

/** Test/reset hook (the reset*Cache precedent in @sendcms/plans and
    @sendcms/security). */
export function resetCronHeartbeatConfigCache(): void {
  configCache = null
}

function parseCronHeartbeatUrl(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

/** The `monitoring.cronHeartbeatUrl` value from config/config.json
    (re-read at most once a minute). A missing file, bad JSON, or a
    missing/blank key all mean "no URL" — the heartbeat is
    owner-configured, so an unconfigured monitor is the normal state,
    not a loud fallback. */
export function readCronHeartbeatUrlFromConfig(
  now: Date = new Date()
): string | null {
  if (
    configCache &&
    now.getTime() - configCache.loadedAt < CRON_HEARTBEAT_CONFIG_CACHE_TTL_MS
  ) {
    return configCache.url
  }
  let url: string | null = null
  const path = resolveConfigPath()
  if (path) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        monitoring?: { cronHeartbeatUrl?: unknown }
      }
      url = parseCronHeartbeatUrl(parsed.monitoring?.cronHeartbeatUrl)
    } catch {
      url = null
    }
  }
  configCache = { url, loadedAt: now.getTime() }
  return url
}

/** The heartbeat URL: env `CRON_HEARTBEAT_URL` first, config file
    second, null when the monitor is not configured. */
export function readCronHeartbeatUrl(): string | null {
  const fromEnv = process.env.CRON_HEARTBEAT_URL?.trim()
  if (fromEnv) return fromEnv
  return readCronHeartbeatUrlFromConfig()
}

/** Pings the dead-man's-switch monitor once. `source` names which
    drain ran — the cron route or the standalone worker — so the
    monitor's log shows which half went silent. Never throws. */
export async function pingCronHeartbeat(
  source: "cron-route" | "worker"
): Promise<void> {
  const url = readCronHeartbeatUrl()
  if (!url) return
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(CRON_HEARTBEAT_TIMEOUT_MS),
    })
    if (!res.ok) {
      logger.warn("cron heartbeat ping failed", {
        source,
        status: res.status,
      })
    }
  } catch (err) {
    logger.warn("cron heartbeat ping failed", {
      source,
      error: err instanceof Error ? err.message : "Unknown error",
    })
  }
}
