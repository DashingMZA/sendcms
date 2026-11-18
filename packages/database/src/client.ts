import { PrismaClient } from "../generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

function createPrismaClient() {
  const rawUrl = process.env.DATABASE_URL
  const isLocal =
    !rawUrl || rawUrl.includes("localhost") || rawUrl.includes("127.0.0.1")

  // Remote DBs: honor the URL's sslmode when it asks for verification
  // (verify-full / verify-ca) — pg verifies the cert against its CA
  // bundle (verified live against the Prisma Postgres dev DB). Any other
  // sslmode keeps the previous behaviour: force TLS without verification.
  // The query string is no longer stripped — stripping it is what made
  // sslmode=verify-full silently unenforced.
  const sslmode = (() => {
    if (isLocal || !rawUrl) return null
    try {
      return new URL(rawUrl).searchParams.get("sslmode")
    } catch {
      return null
    }
  })()
  const verifyCert = sslmode === "verify-full" || sslmode === "verify-ca"

  const adapter = new PrismaPg({
    connectionString: rawUrl,
    max: 5,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: true,
    // Local: no TLS. Remote + verify sslmode: omit ssl so pg honors the
    // URL. Remote otherwise: force TLS without verification (as before).
    ...(isLocal
      ? { ssl: false }
      : verifyCert
        ? {}
        : { ssl: { rejectUnauthorized: false } }),
  })

  return new PrismaClient({ adapter })
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const db = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db
