import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { verifyPassword } from "better-auth/crypto"
import {
  AuditAction,
  AuditResource,
  RateLimitScope,
  db,
} from "@sendcms/database"
import { ApiError } from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"
import { logAudit } from "./audit"
import { checkRateLimit } from "./rate-limit"

const logger = createLogger("step-up")

// Step-up re-authentication (Admin Control Plane, Phase 9): a
// password re-entry that must precede the high-impact admin actions
// (deletion approve/complete, user disable, API key revoke, role
// change, MCP kill-switch toggle).
//
// How it works: `verifyStepUp` checks the admin's password against
// the credential Account row (the same scrypt hash Better Auth
// verifies at sign-in) and, on success, records a `StepUpVerification`
// row that `requireStepUp` accepts until its `expiresAt`. The
// password is never stored, logged, or put in an audit detail — it
// lives only in the request that carries it.
//
// Attempt limiting: every verify call counts as one attempt against a
// per-user 5/hour cap (config/config.json `stepUp.maxAttemptsPerHour`),
// enforced by the shared RateLimitBucket limiter. A limiter error
// fails open (the limiter's own rule) — a broken limiter must never
// lock the owner out of their own admin.
//
// Layered-flow note: this module is the step-up helper's documented
// exception to "only services import `@sendcms/database`" (like the
// audit writer and the rate limiter in the same package) — it exists
// so the password check lives in one place, and it is called only
// from services and the verify route's service call.

// ─── Config ─────────────────────────────────────────────────────────────

export const DEFAULT_STEP_UP_TTL_MINUTES = 10
export const DEFAULT_STEP_UP_MAX_ATTEMPTS_PER_HOUR = 5

export type StepUpConfig = {
  ttlMinutes: number
  maxAttemptsPerHour: number
}

export const DEFAULT_STEP_UP_CONFIG: StepUpConfig = {
  ttlMinutes: DEFAULT_STEP_UP_TTL_MINUTES,
  maxAttemptsPerHour: DEFAULT_STEP_UP_MAX_ATTEMPTS_PER_HOUR,
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback
}

// Pure parse (exported for tests): unknown JSON → a complete config,
// any missing/invalid field falling back to its default. Never throws.
export function parseStepUpConfig(value: unknown): StepUpConfig {
  const root =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {}
  const stepUp =
    typeof root.stepUp === "object" && root.stepUp !== null
      ? (root.stepUp as Record<string, unknown>)
      : {}
  return {
    ttlMinutes: positiveInt(
      stepUp.ttlMinutes,
      DEFAULT_STEP_UP_CONFIG.ttlMinutes
    ),
    maxAttemptsPerHour: positiveInt(
      stepUp.maxAttemptsPerHour,
      DEFAULT_STEP_UP_CONFIG.maxAttemptsPerHour
    ),
  }
}

let stepUpConfigCache: StepUpConfig | null = null

export function resetStepUpConfigCache(): void {
  stepUpConfigCache = null
}

function findWorkspaceRoot(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

// Directory of this module file. The workspace root is resolved from
// here as well as from process.cwd() (DOC-018): in a deployed server
// the working directory is the app directory, not the workspace root,
// so the pnpm-workspace.yaml marker is not discoverable from cwd and
// the old reader silently fell back to defaults — with no error or
// log. Resolving from the module file keeps the configured step-up
// values in effect wherever the process starts.
const moduleDir = dirname(fileURLToPath(import.meta.url))

// Resolves config/config.json, preferring the workspace root found
// from the working directory and falling back to the root found from
// this module file's location. Returns the resolved path and whether
// the module-file fallback was used, or null when neither walk finds
// the workspace marker or the config file.
function resolveConfigPath(): {
  path: string
  viaModuleFile: boolean
} | null {
  for (const [startDir, viaModuleFile] of [
    [process.cwd(), false],
    [moduleDir, true],
  ] as const) {
    const root = findWorkspaceRoot(startDir)
    if (!root) continue
    const path = join(root, "config", "config.json")
    if (existsSync(path)) return { path, viaModuleFile }
  }
  return null
}

// Reads config/config.json once per process (same pattern as the
// rate limiter's readRateLimitConfig). A missing file, bad JSON, or
// missing key all mean "use the defaults". The fallback is LOUD, not
// silent (DOC-018): when the file cannot be found from the working
// directory, or cannot be read at all, a warning names the values
// that fell back to defaults, so an operator can see the platform is
// running on defaults.
export function readStepUpConfig(): StepUpConfig {
  if (stepUpConfigCache) return stepUpConfigCache
  let config = DEFAULT_STEP_UP_CONFIG
  const resolved = resolveConfigPath()
  if (!resolved) {
    logger.warn("config/config.json not found; using default step-up values", {
      cwd: process.cwd(),
      defaults: DEFAULT_STEP_UP_CONFIG,
    })
  } else {
    if (resolved.viaModuleFile) {
      logger.warn(
        "config/config.json not found from working directory; resolved relative to package file",
        { cwd: process.cwd(), configPath: resolved.path }
      )
    }
    try {
      const raw = readFileSync(resolved.path, "utf8")
      config = parseStepUpConfig(JSON.parse(raw) as unknown)
    } catch {
      logger.warn(
        "config/config.json unreadable; using default step-up values",
        {
          configPath: resolved.path,
          defaults: DEFAULT_STEP_UP_CONFIG,
        }
      )
      config = DEFAULT_STEP_UP_CONFIG
    }
  }
  stepUpConfigCache = config
  return stepUpConfigCache
}

// ─── Verify ─────────────────────────────────────────────────────────────

export type StepUpResult = {
  /** The instant the verification stops being accepted. */
  verifiedUntil: Date
}

/** The actor's session, structurally: only the user id is needed. */
export type StepUpSession = {
  user: { id: string }
}

/**
 * Checks the actor's password and records a verification row on
 * success. Throws 422 when the account has no password set
 * (OAuth-only — fail closed, with instructions to set a password
 * first), 429 over the attempt cap, 403 on a wrong password.
 * Returns the verification expiry; the response carries nothing
 * else (never the password, never the hash).
 */
export async function verifyStepUp(
  session: StepUpSession,
  password: string,
  now: Date = new Date()
): Promise<StepUpResult> {
  const userId = session.user.id
  // A malformed call is not a password attempt: it must not consume
  // the attempt cap, and it never reaches the hash comparison.
  if (typeof password !== "string" || password.length === 0) {
    throw new ApiError("Password is required.", 422)
  }
  const config = readStepUpConfig()
  // Both windows carry the same cap, so the hour window is the
  // binding one: at most maxAttemptsPerHour verify calls per user
  // per hour, success or fail. The limiter fails open on error.
  const limit = await checkRateLimit({
    scope: RateLimitScope.STEP_UP,
    subject: `user:${userId}`,
    minuteLimit: config.maxAttemptsPerHour,
    hourLimit: config.maxAttemptsPerHour,
    now,
  })
  if (!limit.allowed) {
    throw new ApiError(
      `Too many verification attempts. Please try again in ${limit.retryAfterSeconds ?? 60} second${(limit.retryAfterSeconds ?? 60) === 1 ? "" : "s"}.`,
      429
    )
  }
  // Never select *: the Account row holds OAuth tokens alongside the
  // password hash, and only the hash may leave the database.
  const account = await db.account.findFirst({
    where: { userId, providerId: "credential" },
    select: { password: true },
  })
  if (!account?.password) {
    await logAudit({
      userId,
      action: AuditAction.STEP_UP_FAILED,
      resourceType: AuditResource.USER,
      resourceId: userId,
      detail: { event: "step-up-failed", reason: "no-password-set" },
    })
    throw new ApiError(
      "No password is set on this account. Set a password in your profile first, then try again.",
      422
    )
  }
  const matches = await verifyPassword({
    hash: account.password,
    password,
  })
  if (!matches) {
    await logAudit({
      userId,
      action: AuditAction.STEP_UP_FAILED,
      resourceType: AuditResource.USER,
      resourceId: userId,
      detail: { event: "step-up-failed", reason: "wrong-password" },
    })
    throw new ApiError("Incorrect password.", 403)
  }
  const verifiedUntil = new Date(now.getTime() + config.ttlMinutes * 60_000)
  await db.stepUpVerification.create({
    data: { userId, verifiedAt: now, expiresAt: verifiedUntil },
  })
  await logAudit({
    userId,
    action: AuditAction.STEP_UP_VERIFIED,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: { event: "step-up-verified" },
  })
  return { verifiedUntil }
}

/**
 * The enforcement point for the five high-impact admin actions.
 * Throws 403 unless the actor has an unexpired verification row
 * (verified within the TTL). Services call this right after their
 * capability check and before touching any data.
 */
export async function requireStepUp(
  session: StepUpSession,
  now: Date = new Date()
): Promise<StepUpResult> {
  const row = await db.stepUpVerification.findFirst({
    where: { userId: session.user.id, expiresAt: { gt: now } },
    orderBy: { verifiedAt: "desc" },
    select: { expiresAt: true },
  })
  if (!row) {
    throw new ApiError(
      "Step-up verification required. Re-enter your password to continue.",
      403
    )
  }
  return { verifiedUntil: row.expiresAt }
}
