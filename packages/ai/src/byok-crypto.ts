import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"
import { ApiError } from "@sendcms/shared"

// BYOK envelope encryption (Admin Control Plane, Phase 5).
//
// A customer's own AI provider key is stored ENCRYPTED, never hashed:
// a hash is one-way, so a hashed key could never be used to call a
// provider. Envelope layout, per UserAiKey row (all fields base64):
//
//   1. A random 32-byte data key (DEK) encrypts the API key with
//      AES-256-GCM (random 12-byte IV, AAD binds userId + provider,
//      so a ciphertext cannot be moved to another user or provider).
//   2. The DEK itself is encrypted with the master key from .env
//      (AI_BYOK_MASTER_KEY), also AES-256-GCM, with its own IV/tag
//      packed into the encryptedDek string as `iv.ciphertext.tag`.
//
// The master key lives OUTSIDE the database (in .env). Rotating it
// only re-encrypts the DEKs — the API keys themselves never need to
// be re-encrypted. `masterKeyVersion` on the row records which master
// key version encrypted that row's DEK.
//
// ROTATION RUNBOOK (SRC-314) — versioned env vars, the simpler
// rotation path (owner decision pending; see the Wave 8 report):
//   1. Generate the new key: `openssl rand -base64 32` (owner-only,
//      never in chat/files).
//   2. Set `AI_BYOK_MASTER_KEY_V2` to the new key alongside the
//      existing `AI_BYOK_MASTER_KEY` (v1). New saves immediately
//      stamp version 2; old rows keep decrypting under v1.
//   3. Re-encrypt every stored DEK with `reencryptByokKey` (a
//      one-off script over UserAiKey rows; it decrypts under the
//      row's version and re-encrypts under the current version).
//   4. Once every row is version 2, promote: set
//      `AI_BYOK_MASTER_KEY` to the v2 value and drop the `_V2` var.
//      Only then is v1 gone — rotating the bare var without steps
//      2–3 breaks every stored key (GCM auth fails, fail-closed).
//
// A missing master key is a platform misconfiguration, not a server
// bug: getByokMasterKey throws an ApiError 503 (ADM-061 / DSH-301)
// carrying the actionable message, so handleApiError surfaces it
// instead of a generic 500 — and the dashboard can tell the user
// the failure is platform config they cannot fix (use "Browser
// only" meanwhile), not a retryable error.
//
// The plaintext key is NEVER logged, returned by an API, or put in
// an audit record. Only its SHA-256 fingerprint is stored, for
// display ("…aB3x") and matching — a fingerprint can never be
// reversed into the key.

/** Current master-key version. Bump when AI_BYOK_MASTER_KEY rotates. */
export const BYOK_MASTER_KEY_VERSION = 1

/** Env var holding master key version `version`. Version 1 is the
    bare `AI_BYOK_MASTER_KEY` (back-compat); version 2+ live in
    `AI_BYOK_MASTER_KEY_V<version>`. */
export function byokMasterKeyEnvVar(version: number): string {
  return version <= 1 ? "AI_BYOK_MASTER_KEY" : `AI_BYOK_MASTER_KEY_V${version}`
}

/** The version new saves encrypt under: the highest versioned key
    present in the env (V2 beats the bare var when both are set),
    else 1. */
export function currentByokMasterKeyVersion(
  env: NodeJS.ProcessEnv = process.env
): number {
  let version = 1
  for (let v = 2; v <= 9; v++) {
    if (env[`AI_BYOK_MASTER_KEY_V${v}`]?.trim()) version = v
  }
  return version
}

const KEY_AAD_PREFIX = "sendcms:byok"
const DEK_AAD_PREFIX = "sendcms:byok-dek"

function byokAad(userId: string, provider: string): Buffer {
  return Buffer.from(`${KEY_AAD_PREFIX}:${userId}:${provider}`, "utf8")
}

function dekAad(userId: string, provider: string): Buffer {
  return Buffer.from(`${DEK_AAD_PREFIX}:${userId}:${provider}`, "utf8")
}

function toBase64(bytes: Buffer): string {
  return bytes.toString("base64")
}

function fromBase64(value: string, label: string): Buffer {
  const bytes = Buffer.from(value, "base64")
  if (bytes.length === 0) throw new Error(`Invalid base64 for ${label}.`)
  return bytes
}

function parseMasterKey(raw: string, envVar: string): Buffer {
  // SRC-314 (secondary): base64 decode silently drops invalid
  // characters, so a 44-char string with one invalid char could
  // still decode to 32 bytes under a DIFFERENT key. Validate with
  // a strict base64 shape first (hex stays a separate branch).
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex")
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      raw
    )
  ) {
    throw new ApiError(
      `${envVar} is not valid base64 (or 64 hex chars). Generate a 32-byte key (e.g. \`openssl rand -base64 32\`) and set it in .env — BYOK keys cannot be stored without it.`,
      503
    )
  }
  const key = Buffer.from(raw, "base64")
  if (key.length !== 32) {
    throw new ApiError(
      `${envVar} must be 32 bytes (44 base64 chars or 64 hex chars).`,
      503
    )
  }
  return key
}

/**
 * The 32-byte master key for one version, from its env var.
 * Throws an ApiError 503 (ADM-061) when missing or the wrong
 * length — never falls back to a default key. The message is the
 * actionable one the dashboard shows: it names the var and how to
 * fix it.
 */
export function getByokMasterKeyForVersion(
  version: number,
  env: NodeJS.ProcessEnv = process.env
): Buffer {
  const envVar = byokMasterKeyEnvVar(version)
  const raw = env[envVar]?.trim()
  if (!raw) {
    throw new ApiError(
      `${envVar} is not set. Generate a 32-byte key (e.g. \`openssl rand -base64 32\`) and set it in .env — BYOK keys cannot be stored without it.`,
      503
    )
  }
  return parseMasterKey(raw, envVar)
}

/**
 * The 32-byte master key, from AI_BYOK_MASTER_KEY. Accepts base64
 * (44 chars) or hex (64 chars). Throws a clear ApiError 503 when
 * missing or the wrong length — never falls back to a default key.
 */
export function getByokMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  return getByokMasterKeyForVersion(currentByokMasterKeyVersion(env), env)
}

/** SHA-256 hex of a plaintext key — display/matching only. */
export function fingerprintKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex")
}

export type EncryptedByokKey = {
  encryptedKey: string
  encryptedDek: string
  keyIv: string
  keyTag: string
  keyFingerprint: string
  masterKeyVersion: number
}

/** Encrypts a customer's API key into the four UserAiKey columns.
    Stamps the CURRENT master-key version (SRC-314: the highest
    versioned key present) — a row always records the version that
    encrypted its DEK, so rotation never orphans it. */
export function encryptByokKey(
  plaintext: string,
  opts: { userId: string; provider: string; masterKey?: Buffer }
): EncryptedByokKey {
  const version = currentByokMasterKeyVersion()
  const masterKey = opts.masterKey ?? getByokMasterKeyForVersion(version)
  // A fresh DEK per key: rotating the master key only re-encrypts DEKs.
  const dek = randomBytes(32)
  const keyIv = randomBytes(12)
  const keyCipher = createCipheriv("aes-256-gcm", dek, keyIv)
  keyCipher.setAAD(byokAad(opts.userId, opts.provider))
  const encryptedKey = Buffer.concat([
    keyCipher.update(plaintext, "utf8"),
    keyCipher.final(),
  ])
  const keyTag = keyCipher.getAuthTag()
  // The DEK is encrypted with the master key; its IV + tag travel
  // inside the packed blob so the row needs no extra columns.
  const dekIv = randomBytes(12)
  const dekCipher = createCipheriv("aes-256-gcm", masterKey, dekIv)
  dekCipher.setAAD(dekAad(opts.userId, opts.provider))
  const encryptedDekBytes = Buffer.concat([
    dekCipher.update(dek),
    dekCipher.final(),
  ])
  const dekTag = dekCipher.getAuthTag()
  return {
    encryptedKey: toBase64(encryptedKey),
    encryptedDek: [
      toBase64(dekIv),
      toBase64(encryptedDekBytes),
      toBase64(dekTag),
    ].join("."),
    keyIv: toBase64(keyIv),
    keyTag: toBase64(keyTag),
    keyFingerprint: fingerprintKey(plaintext),
    masterKeyVersion: version,
  }
}

/** Decrypts a UserAiKey row back to the plaintext API key. The
    master key is selected by the row's `masterKeyVersion` (SRC-314:
    the version was stamped but never read — a rotation broke every
    stored key). A row without a version reads as v1 (back-compat
    with rows written before the version was enforced). An unknown
    version fails loudly: the key for it is gone, and silently
    trying the current key would fail GCM auth anyway. */
export function decryptByokKey(
  row: {
    userId: string
    provider: string
    encryptedKey: string
    encryptedDek: string
    keyIv: string
    keyTag: string
    masterKeyVersion?: number | null
  },
  opts: { masterKey?: Buffer } = {}
): string {
  const masterKey =
    opts.masterKey ?? getByokMasterKeyForVersion(row.masterKeyVersion ?? 1)
  const [dekIvB64, dekCipherB64, dekTagB64] = row.encryptedDek.split(".")
  if (!dekIvB64 || !dekCipherB64 || !dekTagB64) {
    throw new Error("Stored BYOK key has a malformed encrypted data key.")
  }
  const dekDecipher = createDecipheriv(
    "aes-256-gcm",
    masterKey,
    fromBase64(dekIvB64, "DEK IV")
  )
  dekDecipher.setAAD(dekAad(row.userId, row.provider))
  dekDecipher.setAuthTag(fromBase64(dekTagB64, "DEK auth tag"))
  const dek = Buffer.concat([
    dekDecipher.update(fromBase64(dekCipherB64, "encrypted DEK")),
    dekDecipher.final(),
  ])
  const keyDecipher = createDecipheriv(
    "aes-256-gcm",
    dek,
    fromBase64(row.keyIv, "key IV")
  )
  keyDecipher.setAAD(byokAad(row.userId, row.provider))
  keyDecipher.setAuthTag(fromBase64(row.keyTag, "key auth tag"))
  return Buffer.concat([
    keyDecipher.update(fromBase64(row.encryptedKey, "encrypted key")),
    keyDecipher.final(),
  ]).toString("utf8")
}

/** Re-encrypts one stored BYOK row under the CURRENT master key
    version (SRC-314 rotation step 3). Decrypts under the row's
    recorded version, then encrypts fresh (new DEK) under the
    current version — the stored API key VALUE is unchanged, only
    its envelope changes. Returns the new encrypted columns (same
    shape as encryptByokKey) for the caller to persist. The version
    is read from the environment (AI_BYOK_MASTER_KEY_V<version>),
    not from opts.masterKey — a rotation script sets the env vars
    first, then calls this. */
export function reencryptByokKey(
  row: {
    userId: string
    provider: string
    encryptedKey: string
    encryptedDek: string
    keyIv: string
    keyTag: string
    keyFingerprint: string
    masterKeyVersion?: number | null
  },
  opts: { masterKey?: Buffer } = {}
): EncryptedByokKey {
  const plaintext = decryptByokKey(row)
  const version = currentByokMasterKeyVersion()
  if ((row.masterKeyVersion ?? 1) === version) {
    // Already current: return the existing columns unchanged (a
    // re-encryption would only churn the DEK for no benefit).
    return {
      encryptedKey: row.encryptedKey,
      encryptedDek: row.encryptedDek,
      keyIv: row.keyIv,
      keyTag: row.keyTag,
      keyFingerprint: row.keyFingerprint,
      masterKeyVersion: version,
    }
  }
  return encryptByokKey(plaintext, {
    userId: row.userId,
    provider: row.provider,
    masterKey: opts.masterKey,
  })
}
