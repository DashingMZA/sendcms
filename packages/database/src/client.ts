import { PrismaClient } from "../generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

// The pg `ssl` option resolved from a DATABASE_URL, or `{}` to let pg
// honor the URL itself. `{ ssl: false }` means no TLS at all.
export type DatabaseSslOptions = { ssl: false } | Record<string, never>

function isLocalUrl(rawUrl: string | undefined): boolean {
  return !rawUrl || rawUrl.includes("localhost") || rawUrl.includes("127.0.0.1")
}

function readSslmode(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).searchParams.get("sslmode")
  } catch {
    return null
  }
}

// Resolve the pg TLS options for a DATABASE_URL (Phase 16, SRC-304).
// Pure function — unit-tested in tests/database-ssl.test.ts. The URL's
// `sslmode` is honored instead of silently overridden:
// - local (localhost / 127.0.0.1 / unset) → no TLS.
// - `disable` → no TLS (a plaintext-only DB must not be "upgraded" to
//   unverified TLS, which only makes the connection fail).
// - `require` / `prefer` / `allow` → leave pg defaults: pg honors the
//   URL's mode, and its default is verified TLS — never silently
//   downgraded to `rejectUnauthorized: false`.
// - `verify-ca` / `verify-full` → as before: omit `ssl` so pg honors
//   the URL (verified live against the Prisma Postgres dev DB).
// - anything else (including a missing sslmode) on a non-local host →
//   throw: a remote connection must state its TLS mode explicitly.
//   The query string is never stripped — stripping it is what made
//   sslmode=verify-full silently unenforced.
export function resolveDatabaseSsl(
  rawUrl: string | undefined
): DatabaseSslOptions {
  if (isLocalUrl(rawUrl)) return { ssl: false }
  const sslmode = readSslmode(rawUrl as string)
  if (sslmode === "disable") return { ssl: false }
  if (
    sslmode === "require" ||
    sslmode === "prefer" ||
    sslmode === "allow" ||
    sslmode === "verify-ca" ||
    sslmode === "verify-full"
  ) {
    return {}
  }
  throw new Error(
    "DATABASE_URL must include an explicit sslmode for a non-local " +
      "database (use ?sslmode=verify-full; see docs/deployment.md). " +
      `Got sslmode=${sslmode ?? "(missing)"}.`
  )
}

function createPrismaClient() {
  const rawUrl = process.env.DATABASE_URL

  const adapter = new PrismaPg({
    connectionString: rawUrl,
    max: 5,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: true,
    ...resolveDatabaseSsl(rawUrl),
  })

  return new PrismaClient({ adapter })
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const db = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db
