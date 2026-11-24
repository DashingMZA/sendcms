import { db } from "./client"

export interface SystemHealth {
  status: "ok" | "error"
  database: "connected" | "disconnected"
  latencyMs: number
  timestamp: string
}

/**
 * Pings the database to verify connectivity and keep serverless/Supabase connections alive.
 *
 * Phase 16 (SRC-305): the query is wrapped in try/catch, so a down DB
 * returns the documented `{ status: "error", database: "disconnected" }`
 * shape instead of throwing — the "error" / "disconnected" states the
 * return type promises were previously unreachable.
 */
export async function pingDatabase(): Promise<SystemHealth> {
  const start = Date.now()
  try {
    await db.$queryRaw`SELECT 1`
  } catch {
    return {
      status: "error",
      database: "disconnected",
      latencyMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    }
  }
  const latencyMs = Date.now() - start

  return {
    status: "ok",
    database: "connected",
    latencyMs,
    timestamp: new Date().toISOString(),
  }
}
