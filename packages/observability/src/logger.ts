/**
 * Structured logging — one JSON object per line, to stdout (info/warn)
 * or stderr (error). The shape is fixed so logs can be grepped and
 * parsed without knowing which file wrote them:
 * `{ timestamp, level, scope, message, ...fields }`.
 *
 * Level gating: `LOG_LEVEL` env (`info` default; `warn` / `error`
 * silence the lower levels). Read once per `createLogger` call — the
 * loggers are module-level singletons, created at import time.
 *
 * Error values don't JSON-serialize usefully (an Error stringifies to
 * `{}`), so an `error` field holding an Error is flattened to
 * `{ name, message, stack }` before writing.
 */
export type LogLevel = "info" | "warn" | "error"

export type LogFields = Record<string, unknown>

const LEVEL_ORDER: Record<LogLevel, number> = {
  info: 0,
  warn: 1,
  error: 2,
}

function levelFromEnv(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase()
  if (raw === "warn" || raw === "error") return raw
  return "info"
}

export type Logger = {
  info: (message: string, fields?: LogFields) => void
  warn: (message: string, fields?: LogFields) => void
  error: (message: string, fields?: LogFields) => void
}

export function createLogger(scope: string): Logger {
  const minLevel = levelFromEnv()

  function write(level: LogLevel, message: string, fields?: LogFields) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      scope,
      message,
      ...fields,
    }
    if (entry.error instanceof Error) {
      entry.error = {
        name: entry.error.name,
        message: entry.error.message,
        stack: entry.error.stack,
      }
    }
    const line = JSON.stringify(entry)
    if (level === "error") process.stderr.write(line + "\n")
    else process.stdout.write(line + "\n")
  }

  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  }
}
