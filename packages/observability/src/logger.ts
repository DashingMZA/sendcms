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

// Circular-safe serialization (Phase 16, SRC-315): a log field can
// hold a circular structure (a Prisma error `meta`, a request object,
// any caller-passed field) and plain `JSON.stringify` throws on it.
// First retry with a replacer that marks repeats; if even that fails,
// emit a minimal line — the logger never throws.
function safeStringify(entry: Record<string, unknown>): string {
  try {
    return JSON.stringify(entry)
  } catch {
    try {
      const seen = new WeakSet<object>()
      return JSON.stringify(entry, (_key, value) => {
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) return "[Circular]"
          seen.add(value)
        }
        return value
      })
    } catch {
      return JSON.stringify({
        timestamp: entry.timestamp,
        level: entry.level,
        scope: entry.scope,
        message: "log serialization failed",
      })
    }
  }
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
      // Structured errors (e.g. Prisma's KnownRequestError) carry a
      // machine-readable `code` (P2009, P2021, …) and `meta` detail on
      // top of name/message/stack. Keep them: the long `message` gets
      // truncated when a log line is pasted from a terminal, but the
      // short `code` survives and says what kind of failure it was.
      const err = entry.error as Error & { code?: unknown; meta?: unknown }
      entry.error = {
        name: err.name,
        message: err.message,
        stack: err.stack,
        ...(typeof err.code === "string" ? { code: err.code } : {}),
        ...(err.meta !== undefined ? { meta: err.meta } : {}),
      }
    }
    // Logging must never throw (Phase 16, SRC-315): `logAudit`'s
    // never-throws contract runs through here — its catch block's
    // only action is `logger.error(...)`, so a throw in `write`
    // (e.g. `JSON.stringify` on a circular field) would propagate
    // out of the audit writer itself. Serialize circular-safe, and
    // swallow even a failing stdout/stderr write (EPIPE on a closed
    // pipe) — a log line is never worth failing the request.
    const line = safeStringify(entry)
    try {
      if (level === "error") process.stderr.write(line + "\n")
      else process.stdout.write(line + "\n")
    } catch {
      // Ignore: the log line is lost, the request is not.
    }
  }

  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  }
}
