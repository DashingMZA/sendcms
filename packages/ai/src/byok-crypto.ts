import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"

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
// The plaintext key is NEVER logged, returned by an API, or put in
// an audit record. Only its SHA-256 fingerprint is stored, for
// display ("…aB3x") and matching — a fingerprint can never be
// reversed into the key.

/** Current master-key version. Bump when AI_BYOK_MASTER_KEY rotates. */
export const BYOK_MASTER_KEY_VERSION = 1

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

/**
 * The 32-byte master key, from AI_BYOK_MASTER_KEY. Accepts base64
 * (44 chars) or hex (64 chars). Throws a clear error when missing or
 * the wrong length — never falls back to a default key.
 */
export function getByokMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.AI_BYOK_MASTER_KEY?.trim()
  if (!raw) {
    throw new Error(
      "AI_BYOK_MASTER_KEY is not set. Generate a 32-byte key (e.g. `openssl rand -base64 32`) and set it in .env — BYOK keys cannot be stored without it."
    )
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64")
  if (key.length !== 32) {
    throw new Error(
      "AI_BYOK_MASTER_KEY must be 32 bytes (44 base64 chars or 64 hex chars)."
    )
  }
  return key
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

/** Encrypts a customer's API key into the four UserAiKey columns. */
export function encryptByokKey(
  plaintext: string,
  opts: { userId: string; provider: string; masterKey?: Buffer }
): EncryptedByokKey {
  const masterKey = opts.masterKey ?? getByokMasterKey()
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
    masterKeyVersion: BYOK_MASTER_KEY_VERSION,
  }
}

/** Decrypts a UserAiKey row back to the plaintext API key. */
export function decryptByokKey(
  row: {
    userId: string
    provider: string
    encryptedKey: string
    encryptedDek: string
    keyIv: string
    keyTag: string
  },
  opts: { masterKey?: Buffer } = {}
): string {
  const masterKey = opts.masterKey ?? getByokMasterKey()
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
