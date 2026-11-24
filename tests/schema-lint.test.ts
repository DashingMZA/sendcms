/**
 * Phase 16, Wave 3 — schema-lint tests (DB-012 / DB-013 / DB-014 /
 * DB-016 / DB-037 / DB-038 / DB-040 / DB-011 / PRF-011 / PRF-012).
 *
 * Static guard over packages/database/prisma/schema.prisma: the schema
 * is the source of truth for indexes and timestamps, so these rules are
 * asserted by parsing it (plus the module sources for the updated-model
 * rule) instead of by a live database. No test hits the real DB.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const SCHEMA_PATH = "packages/database/prisma/schema.prisma"
const schema = readFileSync(SCHEMA_PATH, "utf8")

type ModelInfo = {
  name: string
  body: string
  clean: string
  // Every index-like column list on the model: @@index, @@unique,
  // single-field @unique, and the PK — a plain index is redundant
  // when it is a strict prefix of any of these.
  indexLists: string[][]
  fkColumns: string[]
  hasCreatedAt: boolean
  hasUpdatedAt: boolean
}

function parseModels(source: string): Map<string, ModelInfo> {
  const models = new Map<string, ModelInfo>()
  for (const match of source.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [, name, body] = match
    // Strip // comments before parsing: the Wave 3 comments name the
    // dropped indexes (e.g. "@@index([userId]) dropped"), and those
    // names must not be mistaken for live schema.
    const clean = body.replace(/\/\/.*$/gm, "")
    const indexLists: string[][] = []
    for (const list of clean.matchAll(/@@(?:index|unique)\(\[([^\]]*)\]\)/g)) {
      indexLists.push(
        list[1]
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
      )
    }
    // Single-field @unique / @id lines (not the @@ forms above).
    for (const line of clean.split("\n")) {
      const field = line.match(/^\s+(\w+)\s+\w+/)
      if (!field) continue
      if (/\s@id(\s|$)/.test(line)) indexLists.push([field[1]])
      else if (/\s@unique(\s|$)/.test(line)) indexLists.push([field[1]])
    }
    const fkColumns: string[] = []
    for (const rel of clean.matchAll(/@relation\(fields:\s*\[([^\]]*)\]/g)) {
      for (const col of rel[1].split(",")) {
        const trimmed = col.trim()
        if (trimmed) fkColumns.push(trimmed)
      }
    }
    models.set(name, {
      name,
      body,
      clean,
      indexLists,
      fkColumns,
      hasCreatedAt: /^\s+createdAt\s+DateTime/m.test(clean),
      hasUpdatedAt: /^\s+updatedAt\s+DateTime/m.test(clean),
    })
  }
  return models
}

const models = parseModels(schema)

function hasIndex(model: string, columns: string[]): boolean {
  const info = models.get(model)
  if (!info) throw new Error(`model ${model} not found in schema`)
  return info.indexLists.some(
    (list) =>
      list.length === columns.length &&
      list.every((col, i) => col === columns[i])
  )
}

// ─── DB-012: every FK column is indexed ────────────────────────────────────

// FK columns exempt from the index rule, with the reason. ApiKeyRateLimit
// carries its FK as the PK, so it is indexed by definition.
const FK_ALLOWLIST: Record<string, string[]> = {
  ApiKeyRateLimit: ["apiKeyId"],
}

describe("schema lint: every FK column is indexed (DB-012)", () => {
  it("covers all 52 FK columns", () => {
    const uncovered: string[] = []
    for (const info of models.values()) {
      const allowed = FK_ALLOWLIST[info.name] ?? []
      for (const col of new Set(info.fkColumns)) {
        const covered = info.indexLists.some((list) => list.includes(col))
        if (!covered && !allowed.includes(col)) {
          uncovered.push(`${info.name}.${col}`)
        }
      }
    }
    expect(uncovered).toEqual([])
  })
})

// ─── DB-038 / DB-040: no redundant (strict-prefix) indexes ─────────────────

function isStrictPrefix(shorter: string[], longer: string[]): boolean {
  return (
    shorter.length < longer.length &&
    shorter.every((col, i) => col === longer[i])
  )
}

describe("schema lint: no redundant indexes (DB-038 / DB-040)", () => {
  it("flags any @@index that is a strict prefix of another index/unique", () => {
    const redundant: string[] = []
    for (const info of models.values()) {
      const plain = [...info.clean.matchAll(/@@index\(\[([^\]]*)\]\)/g)].map(
        (m) =>
          m[1]
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
      )
      for (const list of plain) {
        const coveredBy = info.indexLists.find(
          (other) => other !== list && isStrictPrefix(list, other)
        )
        if (coveredBy) {
          redundant.push(
            `${info.name}.[${list.join(", ")}] is covered by [${coveredBy.join(", ")}]`
          )
        }
      }
    }
    expect(redundant).toEqual([])
  })
})

// ─── DB-016: timestamps on every domain model ───────────────────────────────

// Models without updatedAt, with the reason. Append-only log rows are
// never mutated after insert; Country is seeded reference data that is
// never mutated (createdAt only, by design); StepUpVerification is
// mutated ONLY via @sendcms/security (consumedAt is set by requireStepUp,
// not via any modules service) and its missing updatedAt is a recorded
// Wave 3 follow-up, not a silent exemption — see the Wave 3 execution
// record in docs/production-readiness/phases/phase-16-remediation.md.
const NO_UPDATED_AT_ALLOWLIST: Record<string, string> = {
  SubmissionEvent: "append-only log row",
  AuditLog: "append-only log row",
  SubscriptionEvent: "append-only log row",
  UsageLedger: "append-only metering ledger",
  AiUsageRecord: "append-only usage row",
  McpUsageRecord: "append-only usage row",
  TicketMessage: "append-only thread message",
  Country: "seeded reference data, never mutated (createdAt only)",
  StepUpVerification:
    "mutated only via @sendcms/security (consumedAt); missing updatedAt is a Wave 3 follow-up",
}

describe("schema lint: timestamps (DB-016)", () => {
  it("gives every model a createdAt", () => {
    const missing = [...models.values()]
      .filter((m) => !m.hasCreatedAt)
      .map((m) => m.name)
    expect(missing).toEqual([])
  })

  it("gives every model an updatedAt except the explicit allowlist", () => {
    const missing = [...models.values()]
      .filter((m) => !m.hasUpdatedAt && !(m.name in NO_UPDATED_AT_ALLOWLIST))
      .map((m) => m.name)
    expect(missing).toEqual([])
  })
})

// ─── DB-037: mutated models carry updatedAt ────────────────────────────────

function collectModuleSources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry.endsWith(".ts")) out.push(path)
    }
  }
  // Only each package's src/ — never node_modules or dist output.
  for (const pkg of readdirSync("packages/modules")) {
    const src = join("packages/modules", pkg, "src")
    try {
      if (statSync(src).isDirectory()) walk(src)
    } catch {
      // Packages without a src/ dir (none today) are skipped.
    }
  }
  return out
}

function findUpdatedModels(): string[] {
  const updated = new Set<string>()
  const pattern = /(?:db|tx)\.(\w+)\.(?:update|updateMany|upsert)\s*\(/g
  for (const file of collectModuleSources()) {
    const source = readFileSync(file, "utf8")
    for (const match of source.matchAll(pattern)) {
      const prop = match[1]
      updated.add(prop[0].toUpperCase() + prop.slice(1))
    }
  }
  return [...updated].sort()
}

describe("schema lint: mutated models carry updatedAt (DB-037)", () => {
  it("flags any model updated in packages/modules without updatedAt", () => {
    const offenders = findUpdatedModels().filter((name) => {
      const info = models.get(name)
      return info && !info.hasUpdatedAt && !(name in NO_UPDATED_AT_ALLOWLIST)
    })
    expect(offenders).toEqual([])
  })
})

// ─── DB-013 / DB-014 / DB-011 / PRF-011 / DB-034 / PRF-012: query→index map ─

describe("schema lint: query→index map (DB-013 / DB-014 / DB-011 / PRF-011 / DB-034 / PRF-012)", () => {
  it("serves the subscription webhook lookup (DB-013)", () => {
    expect(
      hasIndex("Subscription", [
        "providerSubscriptionId",
        "status",
        "createdAt",
      ])
    ).toBe(true)
  })

  it("serves the audit idempotency pre-check via the DB-004 partial unique (DB-013)", () => {
    // The proposed plain composite was deliberately NOT added: Wave 1's
    // DB-004 partial unique indexes exactly (correlationId, action,
    // resourceType, resourceId). Pin both halves of that decision.
    const migration = readFileSync(
      "packages/database/prisma/migrations/20261124103000_add_auditlog_correlation_idempotency_idx/migration.sql",
      "utf8"
    )
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "AuditLog_correlation_idempotency_idx"'
    )
    expect(migration).toContain(
      '("correlationId", "action", "resourceType", "resourceId")'
    )
    expect(
      hasIndex("AuditLog", [
        "correlationId",
        "action",
        "resourceType",
        "resourceId",
      ])
    ).toBe(false)
  })

  it("serves listPublishedPlans and the domain/analytics counts (DB-014)", () => {
    expect(hasIndex("Plan", ["status", "isPrivate"])).toBe(true)
    expect(hasIndex("Domain", ["ownerId", "status"])).toBe(true)
    expect(
      hasIndex("Announcement", ["isActive", "audience", "createdAt"])
    ).toBe(true)
  })

  it("serves the owner-scoped submission queries (PRF-011)", () => {
    const submission = models.get("Submission")
    expect(submission?.body).toMatch(/^\s+ownerId\s+String\s*$/m)
    expect(submission?.body).toContain(
      '@relation("SubmissionOwner", fields: [ownerId]'
    )
    expect(hasIndex("Submission", ["ownerId", "createdAt"])).toBe(true)
    expect(hasIndex("Submission", ["ownerId", "status", "createdAt"])).toBe(
      true
    )
  })

  it("serves the IP rate-limit counts and the rescore candidates (DB-011)", () => {
    expect(hasIndex("Submission", ["ipAddress", "createdAt"])).toBe(true)
    expect(hasIndex("Submission", ["status", "aiScoredAt", "createdAt"])).toBe(
      true
    )
  })

  it("serves the bare date-range aggregates (DB-034 / PRF-012)", () => {
    expect(hasIndex("Submission", ["createdAt"])).toBe(true)
    expect(hasIndex("AiUsageRecord", ["createdAt"])).toBe(true)
    expect(hasIndex("McpUsageRecord", ["createdAt"])).toBe(true)
    expect(hasIndex("AiDailyUsage", ["date"])).toBe(true)
    expect(hasIndex("EmailJob", ["formId", "createdAt"])).toBe(true)
  })

  it("serves the owner-scoped outbox listing (DB-034)", () => {
    const emailJob = models.get("EmailJob")
    expect(emailJob?.body).toMatch(/^\s+ownerId\s+String\s*$/m)
    expect(emailJob?.body).toContain(
      '@relation("EmailJobOwner", fields: [ownerId]'
    )
    expect(hasIndex("EmailJob", ["ownerId", "createdAt"])).toBe(true)
    expect(hasIndex("EmailJob", ["ownerId", "status", "createdAt"])).toBe(true)
  })
})
