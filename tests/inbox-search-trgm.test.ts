/**
 * Phase 16, Wave 3 — PRF-019 regression tests (inbox search trigram
 * indexes).
 *
 * Static guard, like the migration-hygiene and schema-lint suites:
 * the suite is fully mocked and never hits a live database, so the
 * live EXPLAIN check (seeded submissions, assert a bitmap/GIN index
 * scan instead of a seq scan) is Stream C's live verification — see
 * the working papers for the exact EXPLAIN to run. These tests pin
 * the parts that must stay true in-repo: the migration creates the
 * extension and all three indexes, the search query names exactly
 * the indexed expressions (so a future rewrite that breaks
 * indexability fails here first), and the schema documents the
 * hand-written indexes (DB-020 pattern).
 */
import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const MIGRATION_DIR =
  "packages/database/prisma/migrations/20261124162000_prf019_inbox_search_trgm"
const MIGRATION_SQL = `${MIGRATION_DIR}/migration.sql`
const SERVICE_PATH = "packages/modules/inbox/src/service.ts"
const SCHEMA_PATH = "packages/database/prisma/schema.prisma"

describe("inbox search trigram indexes (PRF-019)", () => {
  it("ships a migration that installs pg_trgm and all three GIN indexes", () => {
    expect(existsSync(MIGRATION_SQL)).toBe(true)
    const sql = readFileSync(MIGRATION_SQL, "utf8")
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm;")
    expect(sql).toContain(
      'CREATE INDEX "Submission_originDomain_trgm_idx" ON "Submission" USING gin ("originDomain" gin_trgm_ops);'
    )
    expect(sql).toContain(
      'CREATE INDEX "Submission_pageUrl_trgm_idx" ON "Submission" USING gin ("pageUrl" gin_trgm_ops);'
    )
    expect(sql).toContain(
      'CREATE INDEX "Submission_data_text_trgm_idx" ON "Submission" USING gin (("data"::text) gin_trgm_ops);'
    )
    // CONCURRENTLY cannot run inside migrate deploy's transaction
    // (the word may appear in the header comment explaining this).
    expect(sql).not.toMatch(/CREATE\s+INDEX\s+CONCURRENTLY/i)
  })

  it("searches exactly the indexed expressions, owner-scoped (Stream B)", () => {
    const service = readFileSync(SERVICE_PATH, "utf8")
    // The three ILIKE branches must name the indexed expressions
    // verbatim — a rewrite (e.g. a concatenated search expression)
    // would silently drop off the indexes.
    expect(service).toContain('s."originDomain" ILIKE')
    expect(service).toContain('s."pageUrl" ILIKE')
    expect(service).toContain('s."data"::text ILIKE')
    // Still scoped on the denormalized ownerId (PRF-011), never
    // through the Form join.
    expect(service).toContain('s."ownerId" = ')
  })

  it("documents the hand-written indexes in the schema (DB-020 pattern)", () => {
    const schema = readFileSync(SCHEMA_PATH, "utf8")
    expect(schema).toContain("20261124162000_prf019_inbox_search_trgm")
    expect(schema).toContain("Submission_originDomain_trgm_idx")
    expect(schema).toContain("Submission_pageUrl_trgm_idx")
    expect(schema).toContain("Submission_data_text_trgm_idx")
    expect(schema).toContain("pg_trgm")
  })
})
