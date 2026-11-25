import { createHash, randomBytes } from "node:crypto"
import { ApiKeyScope, AuditAction, AuditResource, db } from "@sendcms/database"
import { ApiError } from "@sendcms/shared"
import { logAudit } from "@sendcms/security"
import { checkLimitStrict } from "@sendcms/plans"
import type { CreateApiKeyInput } from "./validators"

// API keys (Phase 11, the MCP auth prerequisite). A key is a per-user
// bearer credential for POST /api/mcp. The plaintext key is shown ONCE
// at creation and never stored — only its SHA-256 hash lives in the DB,
// so a leaked database reveals no usable key. Revocation is a timestamp,
// not a delete: a revoked key stays visible (greyed out) so past usage
// stays attributable.

export const MAX_ACTIVE_API_KEYS = 10

// Key format: sk_live_ + 32 random bytes base64url (43 chars) — 256 bits
// of entropy, the same shape as the domain verification challenges.
export function generateApiKey(): string {
  return `sk_live_${randomBytes(32).toString("base64url")}`
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

// The fields a dashboard list may show. The hash is NEVER selected —
// it must not leave the server.
const publicApiKeySelect = {
  id: true,
  name: true,
  scope: true,
  prefix: true,
  last4: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
} as const

export type ApiKeyPublic = {
  id: string
  name: string
  scope: ApiKeyScope
  prefix: string
  last4: string
  lastUsedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

// The create/rotate response: the public row PLUS the plaintext key,
// shown once. Callers must never persist or re-fetch it.
export type ApiKeyWithPlaintext = ApiKeyPublic & { key: string }

function keyDisplayParts(key: string): { prefix: string; last4: string } {
  return { prefix: key.slice(0, 12), last4: key.slice(-4) }
}

async function getOwnedKeyOrThrow(userId: string, keyId: string) {
  const key = await db.apiKey.findFirst({
    where: { id: keyId, userId },
    select: publicApiKeySelect,
  })
  if (!key) throw new ApiError("API key not found", 404)
  return key
}

export async function listApiKeysForUser(
  userId: string
): Promise<ApiKeyPublic[]> {
  return db.apiKey.findMany({
    where: { userId },
    select: publicApiKeySelect,
    orderBy: { createdAt: "desc" },
  })
}

export async function createApiKeyForUser(
  userId: string,
  input: CreateApiKeyInput
): Promise<ApiKeyWithPlaintext> {
  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user) throw new ApiError("Unauthorized", 401)
  // A key is full account access — same bar as domain registration.
  if (!user.emailVerified) {
    throw new ApiError("Verify your email before creating an API key.", 403)
  }
  // The limit comes from the user's effective plan entitlements.
  // SRC-216: fail CLOSED — a plans-module error refuses key creation
  // (503) instead of silently falling back to the default cap.
  const limit = await checkLimitStrict(userId, "API_KEYS")
  const maxKeys = limit.limit ?? MAX_ACTIVE_API_KEYS
  const key = generateApiKey()
  const { prefix, last4 } = keyDisplayParts(key)
  // SRC-219: the count check used to run outside the insert, so two
  // concurrent creates both saw `maxKeys - 1` active keys and both
  // succeeded. The count + insert now run in ONE transaction under a
  // per-user advisory lock (same shape as domain/form creation), so
  // concurrent creates for one user serialize and at most `maxKeys`
  // active keys can exist. The lock is transaction-scoped: it is
  // released on commit/rollback, never held across requests.
  const created = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"sendcms:create:api-key:" + userId}))`
    const activeCount = await tx.apiKey.count({
      where: { userId, revokedAt: null },
    })
    if (activeCount >= maxKeys) {
      throw new ApiError(
        `You can have at most ${maxKeys} active API keys. Revoke one first.`,
        409
      )
    }
    return tx.apiKey.create({
      data: {
        name: input.name,
        scope: input.scope,
        keyHash: hashApiKey(key),
        prefix,
        last4,
        userId,
      },
      select: publicApiKeySelect,
    })
  })
  await logAudit({
    userId,
    action: AuditAction.CREATE,
    resourceType: AuditResource.API_KEY,
    resourceId: created.id,
    detail: { name: input.name, scope: input.scope },
  })
  return { ...created, key }
}

export async function revokeApiKeyForUser(userId: string, keyId: string) {
  const key = await getOwnedKeyOrThrow(userId, keyId)
  if (key.revokedAt) {
    throw new ApiError("This API key is already revoked.", 409)
  }
  await db.apiKey.update({
    where: { id: key.id },
    data: { revokedAt: new Date() },
  })
  await logAudit({
    userId,
    action: AuditAction.DELETE,
    resourceType: AuditResource.API_KEY,
    resourceId: key.id,
    detail: { name: key.name, scope: key.scope },
  })
}

// Rotate = revoke the old key + issue a fresh one with the same name and
// scope. The old key stops working immediately; the new key is shown
// once, like a fresh create.
export async function rotateApiKeyForUser(
  userId: string,
  keyId: string
): Promise<ApiKeyWithPlaintext> {
  const old = await getOwnedKeyOrThrow(userId, keyId)
  if (old.revokedAt) {
    throw new ApiError("Cannot rotate a revoked API key.", 409)
  }
  const key = generateApiKey()
  const { prefix, last4 } = keyDisplayParts(key)
  const created = await db.$transaction(async (tx) => {
    await tx.apiKey.update({
      where: { id: old.id },
      data: { revokedAt: new Date() },
    })
    return tx.apiKey.create({
      data: {
        name: old.name,
        scope: old.scope,
        keyHash: hashApiKey(key),
        prefix,
        last4,
        userId,
      },
      select: publicApiKeySelect,
    })
  })
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.API_KEY,
    resourceId: old.id,
    detail: { event: "rotated", newKeyId: created.id, name: old.name },
  })
  return { ...created, key }
}

// Resolve a bearer key to its owner. Returns null for an unknown or
// revoked key — the caller turns that into a 401. Updates lastUsedAt
// best-effort: a failed write must not fail authentication.
export async function resolveApiKey(
  plaintextKey: string
): Promise<{ keyId: string; userId: string; scope: ApiKeyScope } | null> {
  const found = await db.apiKey.findUnique({
    where: { keyHash: hashApiKey(plaintextKey) },
    select: { id: true, userId: true, scope: true, revokedAt: true },
  })
  if (!found || found.revokedAt) return null
  void db.apiKey
    .update({
      where: { id: found.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {})
  return { keyId: found.id, userId: found.userId, scope: found.scope }
}
