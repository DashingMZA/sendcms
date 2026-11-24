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
// change, MCP kill-switch toggle) and the sensitive customer actions
// (change-password, change-email, 2FA changes).
//
// Scope confirmation (owner decision, 2026-11-24 — see SEC-104):
// the scope above is final. User suspend, data migration, plan
// publish/archive, subscription assign/cancel, and billing config
// changes are intentionally OUT of scope and execute on the session
// alone. The canonical scope record is
// docs/admin-control-plane/authorization.md.
//
// How it works: `verifyStepUp` checks the actor's password against
// the credential Account row (the same scrypt hash Better Auth
// verifies at sign-in) and, on success, records a `StepUpVerification`
// row that `requireStepUp` accepts exactly once. The row is bound to
// the action that prompted it (`action`) and consumed on first use
// (`consumedAt`) — one password entry unlocks one action, never a
// 10-minute window over all of them. The legacy admin flow mints an
// unbound row (`action: null`) that only the action-less
// `requireStepUp(actor)` call accepts. The password is never stored,
// logged, or put in an audit detail — it lives only in the request
// that carries it.
//
// Attempt limiting: every verify call counts as one attempt against a
// per-user 5/hour cap (config/config.json `stepUp.maxAttemptsPerHour`),
// enforced by the shared RateLimitBucket limiter. A limiter error
// fails open (the limiter's own rule) — a broken limiter must never
// lock the owner out of their own admin.
//
// Cleanup: expired and consumed rows are pruned best-effort by
// `pruneStepUpVerifications`, which verify/require call on their way
// through — no cron owns this table, and the prune never throws, so a
// failing prune can never block a verification.
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

export const STEP_UP_CONFIG_CACHE_TTL_MS = 60_000

// The sensitive actions a step-up verification can be bound to.
// The admin actions mint unbound rows (action null) through the admin
// verify endpoint; the customer actions below are bound by the
// customer verify endpoint and enforced by the auth route wrapper.
export const STEP_UP_ACTIONS = [
  "change-password",
  "change-email",
  "2fa-enable",
  "2fa-disable",
] as const
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number]

export function isStepUpAction(value: unknown): value is StepUpAction {
  return (
    typeof value === "string" &&
    (STEP_UP_ACTIONS as readonly string[]).includes(value)
  )
}

type CachedStepUpConfig = {
  config: StepUpConfig
  loadedAt: number
}

let stepUpConfigCache: CachedStepUpConfig | null = null

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

// Reads config/config.json, re-reading at most every
// STEP_UP_CONFIG_CACHE_TTL_MS (SRC-327): a limit change takes effect
// without a restart (within a minute), while a missing file, bad
// JSON, or missing key all mean "use the defaults". The fallback is
// LOUD, not silent (DOC-018): when the file cannot be found from the
// working directory, or cannot be read at all, a warning names the
// values that fell back to defaults, so an operator can see the
// platform is running on defaults.
export function readStepUpConfig(now: Date = new Date()): StepUpConfig {
  if (
    stepUpConfigCache &&
    now.getTime() - stepUpConfigCache.loadedAt < STEP_UP_CONFIG_CACHE_TTL_MS
  ) {
    return stepUpConfigCache.config
  }
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
  stepUpConfigCache = { config, loadedAt: now.getTime() }
  return config
}

// ─── Prune ──────────────────────────────────────────────────────────────

// Deletes verification rows that can never be used again: expired
// rows and consumed rows (DB-053). Best-effort by design — it never
// throws, so a failing prune can never block a verification or a
// protected action. Returns how many rows were removed.
export async function pruneStepUpVerifications(
  now: Date = new Date()
): Promise<number> {
  try {
    const removed = await db.stepUpVerification.deleteMany({
      where: {
        OR: [{ expiresAt: { lte: now } }, { consumedAt: { not: null } }],
      },
    })
    return removed.count
  } catch (error) {
    logger.error("step-up prune failed, continuing", { error })
    return 0
  }
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
 * first), 429 over the attempt cap, 403 on a wrong password or a
 * non-ACTIVE account. Returns the verification expiry; the response
 * carries nothing else (never the password, never the hash).
 *
 * `options.action` binds the row to one sensitive action
 * (change-password, change-email, 2FA changes); omit it for the
 * legacy admin flow, which mints an unbound row. A suspended user
 * cannot verify at all (SRC-319 secondary) — their subsequent action
 * would be refused anyway, but the verify endpoint itself must not
 * hand them a proof.
 */
export async function verifyStepUp(
  session: StepUpSession,
  password: string,
  options: { action?: string | null; now?: Date } = {}
): Promise<StepUpResult> {
  const userId = session.user.id
  const now = options.now ?? new Date()
  const action = options.action ?? null
  // A malformed call is not a password attempt: it must not consume
  // the attempt cap, and it never reaches the hash comparison.
  if (typeof password !== "string" || password.length === 0) {
    throw new ApiError("Password is required.", 422)
  }
  // A suspended/disabled account cannot mint a proof, even with the
  // right password — the account is closed, not merely session-less.
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { status: true },
  })
  if (user && user.status !== "ACTIVE") {
    await logAudit({
      userId,
      action: AuditAction.STEP_UP_FAILED,
      resourceType: AuditResource.USER,
      resourceId: userId,
      detail: { event: "step-up-failed", reason: "account-not-active" },
    })
    throw new ApiError(
      "This account is suspended or disabled and cannot verify.",
      403
    )
  }
  const config = readStepUpConfig(now)
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
  // Drop spent rows on the way through (DB-053) so the table stays
  // bounded without a cron of its own.
  await pruneStepUpVerifications(now)
  await db.stepUpVerification.create({
    data: { userId, action, verifiedAt: now, expiresAt: verifiedUntil },
  })
  await logAudit({
    userId,
    action: AuditAction.STEP_UP_VERIFIED,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: {
      event: "step-up-verified",
      ...(action ? { action } : {}),
    },
  })
  return { verifiedUntil }
}

export type StepUpVerificationRow = {
  id: string
  verifiedUntil: Date
}

/**
 * Non-consuming read of an unexpired, unconsumed verification for
 * the action (or, with no action, an unbound row). Used by callers
 * that must check the proof BEFORE running the protected action and
 * consume it only when the action succeeds — the auth route wrapper
 * for change-password / change-email / 2FA. Returns null when there
 * is no usable proof.
 */
export async function findStepUpVerification(
  userId: string,
  action: string | null = null,
  now: Date = new Date()
): Promise<StepUpVerificationRow | null> {
  const row = await db.stepUpVerification.findFirst({
    where: {
      userId,
      action: action ?? null,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { verifiedAt: "desc" },
    select: { id: true, expiresAt: true },
  })
  if (!row) return null
  return { id: row.id, verifiedUntil: row.expiresAt }
}

/**
 * Atomically spends one verification row (single UPDATE … WHERE
 * consumedAt IS NULL, so two concurrent consumers cannot both
 * succeed). Returns false when the row was already consumed or is
 * gone — the caller must then refuse the action.
 */
export async function consumeStepUpVerification(
  id: string,
  now: Date = new Date()
): Promise<boolean> {
  const consumed = await db.stepUpVerification.updateMany({
    where: { id, consumedAt: null },
    data: { consumedAt: now },
  })
  return consumed.count > 0
}

/**
 * The enforcement point for the high-impact admin actions (and, with
 * an action, for the sensitive customer actions). Throws 403 unless
 * the actor has an unexpired, unconsumed verification row bound to
 * the action — and CONSUMES it, so one password entry authorizes
 * exactly one protected action. Services call this right after their
 * capability check and before touching any data. With no action it
 * accepts only an unbound (legacy admin) row.
 */
export async function requireStepUp(
  session: StepUpSession,
  options: { action?: string | null; now?: Date } = {}
): Promise<StepUpResult> {
  const now = options.now ?? new Date()
  const action = options.action ?? null
  // Drop spent rows on the way through (DB-053).
  await pruneStepUpVerifications(now)
  const row = await findStepUpVerification(session.user.id, action, now)
  if (!row) {
    throw new ApiError(
      "Step-up verification required. Re-enter your password to continue.",
      403
    )
  }
  if (!(await consumeStepUpVerification(row.id, now))) {
    // Lost a race with another consumer of the same proof.
    throw new ApiError(
      "Step-up verification required. Re-enter your password to continue.",
      403
    )
  }
  return { verifiedUntil: row.verifiedUntil }
}
