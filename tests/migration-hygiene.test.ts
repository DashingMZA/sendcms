// Migration hygiene gates (Phase 16, Wave 3): the process fixes for
// DB-007 / DB-008 / DB-022 / DB-044 (destructive migrations slipped
// through because nothing blocked a Prisma-flagged destructive
// migration) and DB-043 (naming, offline generation, comment drift).
// These are static repo checks — they run in CI with no database.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const MIGRATIONS_DIR = "packages/database/prisma/migrations"

function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => statSync(join(MIGRATIONS_DIR, name)).isDirectory())
    .sort()
}

function migrationSql(dir: string): string {
  return readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8")
}

// Historical migrations grandfathered by the destructive-warning
// gate, with the finding that records them as historical. Applied
// migrations are never edited, so these entries live here (not as
// files in the migration directories) — a NEW migration with the
// header must ship its own destructive-acknowledged.md instead.
const HISTORICAL_DESTRUCTIVE = new Map([
  [
    "20260509102410_add_commenter_and_likes",
    "DB-007: author columns dropped, comment system since removed entirely",
  ],
  [
    "20260616043423_rbac_roles",
    "DB-008: legacy role column dropped, legacy system gone",
  ],
  [
    "20261122050526_add_countries_table",
    "DB-022: countries JSONB dropped 5 minutes after creation, never held data",
  ],
])

// Same pattern for UUID-generating functions in hand-written
// migrations (DB-044): the repo's PK convention is cuid, never UUID.
const HISTORICAL_UUID_FUNCTIONS = new Map([
  [
    "20260616043442_rbac_backfill",
    "DB-044: gen_random_uuid() ids in the RBAC backfill; tables gone",
  ],
  [
    "20260603082016_add_email_notifications",
    "same gen_random_uuid() pattern on the legacy Commenter table; table gone",
  ],
])

// The one offline-generated migration (DB-043): the largest
// migration was produced by `prisma migrate diff` with no shadow DB.
// It applies cleanly from a fresh database (verified Phase 16), so
// it is grandfathered — no NEW migration may carry the disclaimer.
const HISTORICAL_NO_SHADOW_DB = new Set([
  "20261117185033_add_contact_form_models",
])

// The one misleading migration name (DB-043): 20260520103642_init
// only changes a column default. Renaming a directory breaks
// _prisma_migrations matching, so it is grandfathered, never renamed.
const HISTORICAL_GENERIC_NAMES = new Set(["20260520103642_init"])

describe("destructive-migration gate (DB-007 / DB-008 / DB-022)", () => {
  it("fails a migration carrying Prisma's data-loss warning without an approved acknowledgement", () => {
    const offenders: string[] = []
    for (const dir of migrationDirs()) {
      if (!/will be lost/i.test(migrationSql(dir))) continue
      const acknowledged = existsSync(
        join(MIGRATIONS_DIR, dir, "destructive-acknowledged.md")
      )
      if (!acknowledged && !HISTORICAL_DESTRUCTIVE.has(dir)) {
        offenders.push(dir)
      }
    }
    expect(offenders).toEqual([])
  })

  it("keeps the historical allowlist honest — every entry still carries the warning", () => {
    const stale: string[] = []
    for (const dir of HISTORICAL_DESTRUCTIVE.keys()) {
      if (!/will be lost/i.test(migrationSql(dir))) stale.push(dir)
    }
    expect(stale).toEqual([])
  })
})

describe("hand-written migration lint (DB-044)", () => {
  it("flags UUID-generating functions in hand-written migrations", () => {
    const offenders: string[] = []
    for (const dir of migrationDirs()) {
      if (!/gen_random_uuid\(\)|uuid_generate/.test(migrationSql(dir))) {
        continue
      }
      if (!HISTORICAL_UUID_FUNCTIONS.has(dir)) offenders.push(dir)
    }
    expect(offenders).toEqual([])
  })

  it("keeps the historical UUID allowlist honest", () => {
    const stale: string[] = []
    for (const dir of HISTORICAL_UUID_FUNCTIONS.keys()) {
      if (!/gen_random_uuid\(\)|uuid_generate/.test(migrationSql(dir))) {
        stale.push(dir)
      }
    }
    expect(stale).toEqual([])
  })
})

describe("migration naming and generation (DB-043)", () => {
  it("rejects bare generic migration names unless it is the first migration", () => {
    const dirs = migrationDirs()
    const offenders: string[] = []
    for (const dir of dirs) {
      const name = dir.replace(/^\d{14}_/, "")
      if (!["init", "update", "fix"].includes(name)) continue
      if (dir === dirs[0]) continue
      if (HISTORICAL_GENERIC_NAMES.has(dir)) continue
      offenders.push(dir)
    }
    expect(offenders).toEqual([])
  })

  it("rejects a 'no shadow DB' disclaimer in any migration but the grandfathered one", () => {
    const offenders: string[] = []
    for (const dir of migrationDirs()) {
      if (!/no shadow DB/i.test(migrationSql(dir))) continue
      if (!HISTORICAL_NO_SHADOW_DB.has(dir)) offenders.push(dir)
    }
    expect(offenders).toEqual([])
  })
})

describe("billing seed migrations (BIL-125 / BIL-129)", () => {
  it("seeds all five provider config rows (BIL-129)", () => {
    const sql = migrationSql("20261124154500_seed_billing_provider_configs")
    expect(sql).toContain('INSERT INTO "BillingProviderConfig"')
    for (const provider of [
      "STRIPE",
      "PAYPAL",
      "POLAR",
      "FREEMIUS",
      "GUMROAD",
    ]) {
      expect(sql).toContain(`'${provider}'`)
    }
    expect(sql).toContain('ON CONFLICT ("provider") DO NOTHING')
  })

  it("seeds the approved country defaults and nothing else (BIL-125)", () => {
    const sql = migrationSql("20261124154600_seed_billing_provider_countries")
    expect(sql).toContain('INSERT INTO "BillingProviderCountry"')
    // PayPal: US, GB, AU, DE. Gumroad: PK. Stripe/Polar/Freemius get
    // no rows (= all countries), so they must not appear at all.
    expect(sql).toContain("'US', 'GB', 'AU', 'DE'")
    expect(sql).toContain("IN ('PK')")
    expect(sql).not.toContain("'STRIPE'")
    expect(sql).not.toContain("'POLAR'")
    expect(sql).not.toContain("'FREEMIUS'")
    expect(sql).toContain("ON CONFLICT")
    expect(sql).toContain('JOIN "Country"')
  })
})

describe("prisma.seed config (DOC-031)", () => {
  function packageJsonPaths(): string[] {
    const roots = ["", "packages", "apps", "services"]
    const paths: string[] = []
    for (const root of roots) {
      const dir = root === "" ? "." : root
      for (const name of readdirSync(dir)) {
        const candidate = join(dir, name, "package.json")
        if (existsSync(candidate)) paths.push(candidate)
      }
    }
    paths.push("package.json")
    return [...new Set(paths)]
  }

  it("every path named in a prisma.seed key exists on disk", () => {
    const dead: string[] = []
    for (const path of packageJsonPaths()) {
      const pkg = JSON.parse(readFileSync(path, "utf8")) as {
        prisma?: { seed?: string }
      }
      const seed = pkg.prisma?.seed
      if (!seed) continue
      const dir = path.includes("/")
        ? path.slice(0, path.lastIndexOf("/"))
        : "."
      if (!existsSync(join(dir, seed))) dead.push(`${path}: ${seed}`)
    }
    expect(dead).toEqual([])
  })

  it("has no root prisma.seed key — pnpm db:seed is the supported path", () => {
    const root = JSON.parse(readFileSync("package.json", "utf8")) as {
      prisma?: { seed?: string }
      scripts?: Record<string, string>
    }
    expect(root.prisma?.seed).toBeUndefined()
    expect(root.scripts?.["db:seed"]).toContain("db:seed")
    const database = JSON.parse(
      readFileSync("packages/database/package.json", "utf8")
    ) as { scripts?: Record<string, string> }
    expect(database.scripts?.["db:seed"]).toContain("prisma/seed.ts")
  })
})

describe("single PrismaClient construction site (DB-023 / SRC-329)", () => {
  // Built with join() so this file never contains the contiguous
  // needle it searches for — otherwise the test would flag itself.
  const needle = ["new", "PrismaClient"].join(" ")
  const SKIP_DIRS = new Set([
    ".git",
    ".next",
    ".open-next",
    ".turbo",
    "coverage",
    "dist",
    "generated",
    "node_modules",
  ])

  function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) yield* walk(path)
      else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(name)) yield path
    }
  }

  it("constructs PrismaClient only in packages/database/src/client.ts", () => {
    const offenders: string[] = []
    for (const path of walk(".")) {
      if (path === "packages/database/src/client.ts") continue
      if (readFileSync(path, "utf8").includes(needle)) offenders.push(path)
    }
    expect(offenders).toEqual([])
  })

  it("the seed uses the singleton, not its own client", () => {
    const seed = readFileSync("packages/database/prisma/seed.ts", "utf8")
    expect(seed).toContain('from "../src/client"')
    expect(seed).not.toContain(needle)
    expect(seed).not.toContain("PrismaPg")
  })
})

describe("runbook database section (DB-019 / DB-042 / DB-006 / PRF-016 / LVE-015 / DB-043 / DB-020)", () => {
  const runbook = readFileSync("docs/operations/runbook.md", "utf8")

  it("documents the pre-destructive-migration backup step", () => {
    expect(runbook).toContain("## Database backup, migrations, and rollback")
    expect(runbook).toContain("pg_dump -Fc")
    expect(runbook).toContain("DROP TABLE")
    expect(runbook).toContain("restore")
  })

  it("documents the schema-rollback procedure and distinguishes it from plan-version rollback", () => {
    expect(runbook).toContain("compensating forward migration")
    expect(runbook).toContain("_prisma_migrations")
    expect(runbook).toContain("plan-version rollback")
  })

  it("carries the pre-deploy auth check for the auth-switch migration", () => {
    expect(runbook).toContain("switch_auth_to_better_auth")
    expect(runbook).toContain("row counts")
  })

  it("records the backup/PITR status as unconfirmed, not invented", () => {
    expect(runbook).toContain("Prisma dashboard")
    expect(runbook).toContain("NOT CONFIRMED")
    expect(runbook).toContain("Restore drill")
  })

  it("states the Render free-plan migration hard gate", () => {
    expect(runbook).toContain("preDeployCommand")
    expect(runbook).toContain("blocked")
  })

  it("documents the migration-hygiene guide and the drift check", () => {
    expect(runbook).toContain("Migration hygiene")
    expect(runbook).toContain("Tie-break rule")
    expect(runbook).toContain("destructive-acknowledged.md")
    expect(runbook).toContain("migrate diff")
    expect(runbook).toContain("20261117190655_single_platform_owner")
  })
})

describe("deployment docs (DB-043 / DOC-031 / LVE-015)", () => {
  it("states minimum Postgres 17 and the supported seed path", () => {
    const deployment = readFileSync("docs/deployment.md", "utf8")
    expect(deployment).toContain("17+ (minimum)")
    expect(deployment).toContain("postgres:17-alpine")
    expect(deployment).toContain("pnpm db:seed` is the supported path")
    expect(deployment).toContain("no root `prisma.seed` key")
  })

  it("states the Render free-plan migration hard gate", () => {
    const platforms = readFileSync("docs/deployment/platforms.md", "utf8")
    expect(platforms).toContain("Hard gate")
    expect(platforms).toContain("preDeployCommand")
    expect(platforms).toContain("blocked")
  })

  it("links the migration-hygiene guide from the monorepo doc", () => {
    const monorepo = readFileSync("docs/development/monorepo.md", "utf8")
    expect(monorepo).toContain("migration-hygiene-db-043")
  })

  it("documents the hand-written partial index in the schema (DB-020)", () => {
    const schema = readFileSync(
      "packages/database/prisma/schema.prisma",
      "utf8"
    )
    expect(schema).toContain("20261117190655_single_platform_owner")
    expect(schema).toContain("User_single_platform_owner_idx")
  })
})
