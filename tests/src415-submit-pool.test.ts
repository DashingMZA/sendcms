// SRC-415 — submit transaction deadlocks against the max:5 pool.
//
// LIVE-DB SUITE. The mocked submit suites cannot prove this defect: the
// deadlock needs REAL concurrent transactions holding REAL pool
// connections. These tests drive the real `submitForm` service (real
// `checkLimitStrict` / `getEffectiveEntitlements` / `getUsedForMeter`,
// real Prisma pool `max: 5`) against a real Postgres, in-process —
// no dev server needed, because the wedge is inside the service's
// `db.$transaction`, not in the HTTP layer.
//
// Gated like tests/doc003-registration-approval.test.ts: SKIPPED unless
// SRC415_LIVE_DB=1 and DATABASE_URL points at the dedicated scratch
// database `sendcms_src415` (created fresh for this suite with
// `prisma migrate deploy`, 57/57 migrations). The gate refuses any
// other database name, so these tests can never run against the real
// dev DB. Run:
//   SRC415_LIVE_DB=1 DATABASE_URL='<redacted>' \
//     pnpm vitest run tests/src415-submit-pool.test.ts
//
// What each test proves (all with `meta.ip: null`, so the per-IP
// minute/hour limits and the IP advisory lock are out of the picture —
// the burst under test is owner+form contention, exactly the SRC-415
// shape):
//  1. n=5 distinct submits to one form: all 201 (kind "created"), 5 rows.
//     Unfixed code fails 1 in 5 with a 503 pool timeout.
//  2. n=30 distinct submits to one form: all 201, 30 rows. Unfixed code
//     fails ~87% (5×500 + 21×503 in the Phase 17 probe).
//  3. n=12 IDENTICAL submits (content-hash dedupe): every call succeeds
//     (created or duplicate), exactly 1 row, all duplicates point at the
//     same submission id — race semantics hold AND no pool failures.
//  4. Daily limit 3, n=8 distinct submits: exactly 3 created, 5× 429
//     (daily limit), zero 500/503 — the limit is enforced exactly under
//     concurrency, not wedged by it.
//
// Failure signature on the unfixed tree: `LimitCheckError` 503 ("The plan
// limit could not be checked. Please try again.") or a pool-timeout 500
// ("timeout exceeded when trying to connect"), ~10–12 s per call.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { db } from "@sendcms/database"
import { submitForm } from "@sendcms/submissions"
import { ApiError } from "@sendcms/api-client"

const DB_URL = process.env.DATABASE_URL ?? ""
const enabled =
  process.env.SRC415_LIVE_DB === "1" && DB_URL.includes("sendcms_src415")

const run = `s415${Date.now().toString(36)}${Math.random()
  .toString(36)
  .slice(2, 6)}`
let counter = 0

const ORIGIN = "https://demo.example.com/contact"
const DOMAIN = "demo.example.com"

type Attempt =
  | { ok: true; kind: "created" | "duplicate"; id: string }
  | { ok: false; status: number; message: string }

async function attempt(
  ownerId: string,
  formId: string,
  fields: Record<string, string>
): Promise<Attempt> {
  try {
    const result = await submitForm(
      {
        userId: ownerId,
        formId,
        fields,
        pageUrl: "https://demo.example.com/contact",
      },
      { origin: ORIGIN, ip: null, userAgent: "src415-test" }
    )
    if (result.kind === "honeypot") {
      return { ok: false, status: 500, message: "unexpected honeypot" }
    }
    return { ok: true, kind: result.kind, id: result.submission.id }
  } catch (err) {
    if (err instanceof ApiError) {
      return { ok: false, status: err.status, message: err.message }
    }
    return { ok: false, status: 500, message: String(err) }
  }
}

function distinctFields(i: number): Record<string, string> {
  return {
    name: "Load",
    email: "load@example.com",
    message: `src415 burst ${run} #${i}`,
  }
}

describe.skipIf(!enabled)(
  "SRC-415 — submit burst vs max:5 pool (live DB)",
  () => {
    let ownerId: string
    let domainId: string

    async function makeForm(dailyLimit: number | null): Promise<string> {
      counter += 1
      const form = await db.form.create({
        data: {
          name: `SRC-415 form ${run}-${counter}`,
          ownerId,
          honeypotEnabled: false,
          turnstileEnabled: false,
          dailyLimit,
          fields: {
            create: [
              {
                name: "name",
                label: "Name",
                type: "TEXT",
                required: true,
                order: 0,
              },
              {
                name: "email",
                label: "Email",
                type: "EMAIL",
                required: true,
                order: 1,
              },
              {
                name: "message",
                label: "Message",
                type: "TEXTAREA",
                required: true,
                order: 2,
              },
            ],
          },
          domainLinks: { create: { domainId } },
        },
      })
      return form.id
    }

    beforeAll(async () => {
      // Defense in depth: the gate already requires the scratch DB name in
      // DATABASE_URL — prove it again from the server side.
      const dbName = await db.$queryRaw<{ current_database: string }[]>`
      SELECT current_database()
    `
      expect(dbName[0]?.current_database).toBe("sendcms_src415")

      // Fresh start: the DB is scratch-only for this suite, so wipe the
      // tables this suite touches (a previous failed run must not leave
      // rows behind — counts below are exact).
      await db.submissionEvent.deleteMany()
      await db.emailJob.deleteMany()
      await db.usageLedger.deleteMany()
      await db.submission.deleteMany()
      await db.notificationSettings.deleteMany()
      await db.formField.deleteMany()
      await db.formDomain.deleteMany()
      await db.form.deleteMany()
      await db.domainVerification.deleteMany()
      await db.domain.deleteMany()
      await db.entitlementOverride.deleteMany()
      await db.subscriptionEvent.deleteMany()
      await db.subscription.deleteMany()
      await db.session.deleteMany()
      await db.account.deleteMany()
      await db.verification.deleteMany()
      await db.user.deleteMany()

      const owner = await db.user.create({
        data: {
          name: "SRC-415 Owner",
          email: `src415-owner-${run}@example.com`,
          emailVerified: true,
        },
      })
      ownerId = owner.id
      const domain = await db.domain.create({
        data: {
          name: DOMAIN,
          domain: DOMAIN,
          status: "VERIFIED",
          verifiedAt: new Date(),
          ownerId,
        },
      })
      domainId = domain.id
    }, 120_000)

    afterAll(async () => {
      await db.$disconnect()
    }, 60_000)

    it("n=5 distinct submits to one form: all 201, 5 rows", async () => {
      const formId = await makeForm(null)
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          attempt(ownerId, formId, distinctFields(i))
        )
      )
      const failures = results.filter((r) => !r.ok)
      expect(
        failures,
        `expected zero failures, got: ${JSON.stringify(failures)}`
      ).toHaveLength(0)
      expect(results.filter((r) => r.ok && r.kind === "created")).toHaveLength(
        5
      )
      expect(await db.submission.count({ where: { formId } })).toBe(5)
    }, 120_000)

    it("n=30 distinct submits to one form: all 201, 30 rows", async () => {
      const formId = await makeForm(null)
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          attempt(ownerId, formId, distinctFields(i))
        )
      )
      const failures = results.filter((r) => !r.ok)
      expect(
        failures,
        `expected zero failures, got: ${JSON.stringify(failures)}`
      ).toHaveLength(0)
      expect(results.filter((r) => r.ok && r.kind === "created")).toHaveLength(
        30
      )
      expect(await db.submission.count({ where: { formId } })).toBe(30)
    }, 120_000)

    it("n=12 identical submits: all succeed, exactly 1 row (dedupe holds)", async () => {
      const formId = await makeForm(null)
      const same = distinctFields(999)
      const results = await Promise.all(
        Array.from({ length: 12 }, () => attempt(ownerId, formId, { ...same }))
      )
      const failures = results.filter((r) => !r.ok)
      expect(
        failures,
        `expected zero failures, got: ${JSON.stringify(failures)}`
      ).toHaveLength(0)
      // No 500/503 anywhere, even among the successes: a duplicate is a
      // 200, a create is a 201 — both are `ok` here by construction.
      expect(await db.submission.count({ where: { formId } })).toBe(1)
      const ids = new Set(
        results.filter((r) => r.ok).map((r) => (r as { id: string }).id)
      )
      expect(ids.size).toBe(1)
    }, 120_000)

    it("daily limit 3, n=8 distinct submits: exactly 3 created, 5x 429, zero 500/503", async () => {
      const formId = await makeForm(3)
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          attempt(ownerId, formId, distinctFields(i))
        )
      )
      const created = results.filter((r) => r.ok && r.kind === "created")
      const rejected = results.filter((r) => !r.ok)
      expect(created).toHaveLength(3)
      expect(rejected).toHaveLength(5)
      expect(rejected.map((r) => (r as { status: number }).status)).toEqual([
        429, 429, 429, 429, 429,
      ])
      expect(
        rejected.filter((r) => (r as { status: number }).status >= 500)
      ).toHaveLength(0)
      expect(await db.submission.count({ where: { formId } })).toBe(3)
    }, 120_000)
  }
)
