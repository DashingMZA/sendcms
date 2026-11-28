// .env file loading for the SDK build (SRC-309).
//
// The bundle inlines `__APP_URL__` from the environment, and the build
// reads `.env` then `.env.local` — with `.env.local` winning, like
// dotenv: a developer overriding `NEXT_PUBLIC_API_URL` in `.env.local`
// gets that value baked into `v1.js`. The old hand-rolled loader used
// set-if-absent for both files, so the FIRST file (`.env`) always won
// and the `.env.local` override silently did nothing.
//
// Precedence, highest first: the real process environment, then
// `.env.local`, then `.env`. Handles `export KEY=` prefixes and inline
// comments on unquoted values (`KEY=value # comment`); quoted values
// keep their `#` (and their quotes are stripped).
import { existsSync, readFileSync } from "node:fs"

/** Parse one `.env` line. Returns null for blanks, comments, and lines without `=`. */
export function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) return null
  const withoutExport = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length).trim()
    : trimmed
  const eq = withoutExport.indexOf("=")
  if (eq === -1) return null
  const key = withoutExport.slice(0, eq).trim()
  if (!key) return null
  let value = withoutExport.slice(eq + 1).trim()
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  if (quoted) {
    value = value.slice(1, -1)
  } else {
    // Inline comment: ` #` starts one, but only for unquoted values.
    const hash = value.indexOf(" #")
    if (hash !== -1) value = value.slice(0, hash).trim()
  }
  return [key, value]
}

/**
 * Load `.env` then `.env.local` into `process.env`, in that order.
 * `env` is the target object (defaults to `process.env`); keys the
 * real environment already sets are never overridden by a file.
 */
export function loadEnvFiles(
  envPath: string,
  envLocalPath: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  // Snapshot the real environment first: a file must never override a
  // value the process was actually started with.
  const realEnvKeys = new Set(Object.keys(env))
  const load = (path: string, overrideFileValues: boolean): void => {
    if (!existsSync(path)) return
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const parsed = parseEnvLine(line)
      if (!parsed) continue
      const [key, value] = parsed
      if (realEnvKeys.has(key)) continue
      if (overrideFileValues || env[key] === undefined) {
        env[key] = value
      }
    }
  }
  load(envPath, false)
  load(envLocalPath, true)
}
