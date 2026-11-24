/**
 * Phase 16, SRC-304 — the DB TLS resolver honors the DATABASE_URL's
 * `sslmode` instead of silently overriding it, and fails fast when a
 * remote URL states no mode at all.
 */
import { describe, expect, it } from "vitest"

import { resolveDatabaseSsl } from "@sendcms/database"

describe("resolveDatabaseSsl", () => {
  it("uses no TLS for local databases", () => {
    expect(resolveDatabaseSsl(undefined)).toEqual({ ssl: false })
    expect(
      resolveDatabaseSsl("postgres://user:pass@localhost:5432/sendcms")
    ).toEqual({ ssl: false })
    expect(
      resolveDatabaseSsl("postgres://user:pass@127.0.0.1:5432/sendcms")
    ).toEqual({ ssl: false })
  })

  it("honors sslmode=disable — no TLS, never an unverified upgrade", () => {
    expect(
      resolveDatabaseSsl(
        "postgres://user:pass@db.example.com:5432/sendcms?sslmode=disable"
      )
    ).toEqual({ ssl: false })
  })

  it("leaves pg defaults for require / prefer / allow (verified TLS)", () => {
    for (const mode of ["require", "prefer", "allow"]) {
      expect(
        resolveDatabaseSsl(
          `postgres://user:pass@db.example.com:5432/sendcms?sslmode=${mode}`
        )
      ).toEqual({})
    }
  })

  it("leaves pg defaults for verify-ca / verify-full (as before)", () => {
    for (const mode of ["verify-ca", "verify-full"]) {
      expect(
        resolveDatabaseSsl(
          `postgres://user:pass@db.example.com:5432/sendcms?sslmode=${mode}`
        )
      ).toEqual({})
    }
  })

  it("fails fast when a remote URL has no sslmode", () => {
    expect(() =>
      resolveDatabaseSsl("postgres://user:pass@db.example.com:5432/sendcms")
    ).toThrow(/explicit sslmode/)
  })

  it("fails fast on an unknown sslmode", () => {
    expect(() =>
      resolveDatabaseSsl(
        "postgres://user:pass@db.example.com:5432/sendcms?sslmode=bogus"
      )
    ).toThrow(/explicit sslmode/)
  })
})
