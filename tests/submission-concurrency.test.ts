// Real-DB concurrency tests (Phase 16, TST-006 dedupe/quota part +
// SRC-204 / DB-017 / DB-004 regression). These run against the REAL
// database — no mocks — so they prove the advisory-lock transaction
// in submitForm and the AuditLog correlation unique index actually
// hold under parallel calls. Skipped when DATABASE_URL is absent
// (CI without a database, or a plain unit run).
//
// Every case builds its own isolated user + VERIFIED domain + form
// (unique emails/domains per run) and tears them down afterwards, so
// a run never pollutes the shared dev database.
//
// Concurrency ceiling: the bursts are 2–4 simultaneous callers, not
// 10–12. The shared client pools 5 connections
// (packages/database/src/client.ts: max 5, connectionTimeoutMillis
// 10s), and each submit holds one connection through ~6 sequential
// pre-transaction queries plus its transaction — a 10-way burst
// fails on pool checkout ("timeout exceeded when trying to
// connect"), which is an environment limit, not the mechanism under
// test. Four-way is plenty to open the check-then-insert race the
// advisory lock closes; the IP limit is tripped by pre-seeding
// instead of by sheer burst size.
import { afterAll, describe, expect, it, vi } from "vitest"

// Real-DB calls to db.prisma.io are slow (remote + a loaded
// machine): the default 5s per-test timeout is far too short.
vi.setConfig({ testTimeout: 120_000 })

const hasDb = Boolean(process.env.DATABASE_URL)

import { AuditAction, AuditResource, db } from "@sendcms/database"
import { ApiError } from "@sendcms/shared"
import { submitForm, type SubmitResult } from "@sendcms/submissions"
import { logAudit } from "@sendcms/security"
import { createFlag, setFlag } from "@sendcms/platform-ops"

type Fixture = {
  userId: string
  domain: string
  formId: string
  ip: string
}

const fixtures: Fixture[] = []

function tag(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function makeFixture(
  opts: { dailyLimit?: number } = {}
): Promise<Fixture> {
  const t = tag()
  const user = await db.user.create({
    data: { name: "Concurrency Test", email: `concurrency-${t}@example.test` },
  })
  const domain = await db.domain.create({
    data: {
      name: `${t}.example.test`,
      domain: `${t}.example.test`,
      ownerId: user.id,
      status: "VERIFIED",
      verifiedAt: new Date(),
    },
  })
  const form = await db.form.create({
    data: {
      name: `Concurrency ${t}`,
      ownerId: user.id,
      dailyLimit: opts.dailyLimit ?? null,
    },
  })
  await db.formField.createMany({
    data: [
      {
        formId: form.id,
        name: "name",
        label: "Name",
        type: "TEXT",
        required: true,
        order: 0,
      },
      {
        formId: form.id,
        name: "email",
        label: "Email",
        type: "EMAIL",
        required: true,
        order: 1,
      },
      {
        formId: form.id,
        name: "message",
        label: "Message",
        type: "TEXTAREA",
        required: true,
        order: 2,
      },
    ],
  })
  await db.formDomain.create({
    data: { formId: form.id, domainId: domain.id },
  })
  // TEST-NET-3 address, unique per fixture: the IP-minute limit counts
  // globally per IP, so a fresh IP keeps each case independent of
  // earlier runs.
  const ip = `203.0.113.${1 + Math.floor(Math.random() * 250)}`
  const fixture = {
    userId: user.id,
    domain: domain.domain,
    formId: form.id,
    ip,
  }
  fixtures.push(fixture)
  return fixture
}

async function submit(
  fixture: Fixture,
  message: string,
  idempotencyKey?: string
) {
  return submitForm(
    {
      userId: fixture.userId,
      formId: fixture.formId,
      fields: {
        name: "Tester",
        email: "visitor@example.com",
        message,
      },
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
    {
      origin: `https://${fixture.domain}`,
      ip: fixture.ip,
      userAgent: "vitest-concurrency",
    }
  )
}

function isApiError(err: unknown, status: number): boolean {
  return err instanceof ApiError && err.status === status
}

afterAll(async () => {
  // Pattern-based (not just the fixtures list): a test that times
  // out can leave rows behind after its own teardown, so sweep
  // everything this file could have created.
  const users = await db.user.findMany({
    where: { email: { startsWith: "concurrency-" } },
    select: { id: true },
  })
  const userIds = [
    ...new Set([...users.map((u) => u.id), ...fixtures.map((f) => f.userId)]),
  ]
  const forms = await db.form.findMany({
    where: { ownerId: { in: userIds } },
    select: { id: true },
  })
  const formIds = [
    ...new Set([...forms.map((f) => f.id), ...fixtures.map((f) => f.formId)]),
  ]
  if (formIds.length > 0) {
    await db.submissionEvent.deleteMany({
      where: { submission: { formId: { in: formIds } } },
    })
    await db.submission.deleteMany({ where: { formId: { in: formIds } } })
    await db.emailJob.deleteMany({ where: { formId: { in: formIds } } })
    await db.formField.deleteMany({ where: { formId: { in: formIds } } })
    await db.formDomain.deleteMany({ where: { formId: { in: formIds } } })
    await db.form.deleteMany({ where: { id: { in: formIds } } })
  }
  if (userIds.length > 0) {
    await db.usageLedger.deleteMany({ where: { userId: { in: userIds } } })
    await db.domain.deleteMany({ where: { ownerId: { in: userIds } } })
    await db.auditLog.deleteMany({
      where: {
        OR: [
          { correlationId: { startsWith: "corr-concurrency-" } },
          { resourceId: { in: userIds } },
        ],
      },
    })
    await db.user.deleteMany({ where: { id: { in: userIds } } })
  }
  await db.featureFlag.deleteMany({
    where: { key: { startsWith: "conc-flag-" } },
  })
  await db.auditLog.deleteMany({
    where: { resourceId: { startsWith: "conc-flag-" } },
  })
  await db.$disconnect()
})

describe.skipIf(!hasDb)("submission concurrency (real DB)", () => {
  it("4 concurrent identical submits store exactly 1 row (SRC-204/DB-017)", async () => {
    const fixture = await makeFixture()
    const results = await Promise.all(
      Array.from({ length: 4 }, () => submit(fixture, "same message"))
    )
    // created and duplicate share one SubmitResult variant (kind is
    // "created" | "duplicate"), so both filters narrow to it; the
    // runtime kind check still separates them.
    const created = results.filter(
      (r): r is Extract<SubmitResult, { kind: "created" | "duplicate" }> =>
        r.kind === "created"
    )
    const duplicates = results.filter(
      (r): r is Extract<SubmitResult, { kind: "created" | "duplicate" }> =>
        r.kind === "duplicate"
    )
    expect(created).toHaveLength(1)
    expect(duplicates).toHaveLength(3)
    // Every duplicate points at the one stored row.
    for (const d of duplicates) {
      expect(d.submission.id).toBe(created[0].submission.id)
    }
    const stored = await db.submission.count({
      where: { formId: fixture.formId },
    })
    expect(stored).toBe(1)
  })

  it("dailyLimit 1: 2 concurrent distinct submits -> 1 created + 1x 429", async () => {
    const fixture = await makeFixture({ dailyLimit: 1 })
    const settled = await Promise.allSettled([
      submit(fixture, "first message"),
      submit(fixture, "second message"),
    ])
    const fulfilled = settled.filter(
      (s) => s.status === "fulfilled"
    ) as PromiseFulfilledResult<Awaited<ReturnType<typeof submit>>>[]
    const rejected = settled.filter(
      (s) => s.status === "rejected"
    ) as PromiseRejectedResult[]
    expect(fulfilled).toHaveLength(1)
    expect(fulfilled[0].value.kind).toBe("created")
    expect(rejected).toHaveLength(1)
    expect(isApiError(rejected[0].reason, 429)).toBe(true)
    const stored = await db.submission.count({
      where: { formId: fixture.formId },
    })
    expect(stored).toBe(1)
  })

  it("IP minute limit: 9 pre-seeded + 3 concurrent distinct submits -> 1 created + 2x 429", async () => {
    const fixture = await makeFixture()
    // Seed the IP up to 9 in the last minute, so the burst only needs
    // 3 concurrent callers to trip the 10/min limit — 12 simultaneous
    // transactions would swamp the driver's pool (10 connections)
    // and fail on pool checkout, which is not what this test proves.
    await db.submission.createMany({
      data: Array.from({ length: 9 }, (_, i) => ({
        formId: fixture.formId,
        data: { message: `seed ${i}` },
        status: "NEW",
        originDomain: fixture.domain,
        ipAddress: fixture.ip,
        contentHash: `seed-hash-${i}`,
      })),
    })
    const settled = await Promise.allSettled(
      Array.from({ length: 3 }, (_, i) => submit(fixture, `message ${i}`))
    )
    const fulfilled = settled.filter((s) => s.status === "fulfilled")
    const rejected = settled.filter(
      (s) => s.status === "rejected"
    ) as PromiseRejectedResult[]
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(2)
    for (const r of rejected) {
      expect(isApiError(r.reason, 429)).toBe(true)
    }
    const stored = await db.submission.count({
      where: { formId: fixture.formId },
    })
    expect(stored).toBe(10)
  })

  it("same idempotency key: 4 concurrent distinct submits store 1 row", async () => {
    const fixture = await makeFixture()
    const key = `key-${tag()}`
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => submit(fixture, `keyed ${i}`, key))
    )
    const ids = new Set(
      results
        .filter(
          (r): r is Extract<SubmitResult, { kind: "created" | "duplicate" }> =>
            r.kind === "created" || r.kind === "duplicate"
        )
        .map((r) => r.submission.id)
    )
    expect(ids.size).toBe(1)
    const stored = await db.submission.count({
      where: { formId: fixture.formId },
    })
    expect(stored).toBe(1)
  })

  it("2 concurrent logAudit calls with the same correlation tuple write 1 row (DB-004/SRC-331)", async () => {
    const fixture = await makeFixture()
    const correlationId = `corr-concurrency-${tag()}`
    const input = {
      userId: fixture.userId,
      action: AuditAction.UPDATE,
      resourceType: AuditResource.USER,
      resourceId: fixture.userId,
      detail: { event: "concurrency-probe" },
      correlationId,
    }
    await Promise.all([logAudit(input), logAudit(input)])
    const rows = await db.auditLog.count({ where: { correlationId } })
    expect(rows).toBe(1)
  })

  it("2 concurrent setFlag toggles in opposite directions each audit the value they replaced (DB-051)", async () => {
    const fixture = await makeFixture()
    // setFlag needs a platform-owner admin session; the role check is
    // pure (no DB session lookup), so a plain session object works.
    const actor = {
      user: { id: fixture.userId, platformRole: "PLATFORM_OWNER" as const },
    }
    const key = `conc-flag-${tag()}`.replace(/[^a-z0-9-]/g, "-")
    await createFlag(actor as never, { key, name: "Concurrency flag" })
    await Promise.all([
      setFlag(actor as never, key, { isEnabled: true, reason: "up" }),
      setFlag(actor as never, key, { isEnabled: false, reason: "down" }),
    ])
    // One toggle replaced false, the other replaced true — the
    // locked before-read saw the value the write actually replaced.
    // (createFlag writes its own flag-created row with no
    // oldIsEnabled, so only the toggle rows count.)
    //
    // Which serial order the two toggles land in is racy by design:
    // if the false-writer wins the lock first its write is a no-op
    // and BOTH reads see false; if the true-writer wins first, the
    // second read sees true. Either way the audit trail must be
    // consistent with SOME serial order — that is what the lock
    // guarantees, and what a stale unlocked read would violate
    // (olds [false, false] with a final value of false, or olds
    // [false, true] with a final value of true, match no order).
    const rows = await db.auditLog.findMany({
      where: { resourceType: "FEATURE_FLAG", resourceId: key },
      select: { detail: true },
    })
    const olds = rows
      .map((r) => r.detail as { event?: string; oldIsEnabled?: unknown } | null)
      .filter((d) => d?.event === "flag-toggled")
      .map((d) => d?.oldIsEnabled)
      .sort()
    const final = await db.featureFlag.findUnique({
      where: { key },
      select: { isEnabled: true },
    })
    const serialConsistent =
      (olds.join(",") === "false,false" && final?.isEnabled === true) ||
      (olds.join(",") === "false,true" && final?.isEnabled === false)
    expect(serialConsistent).toBe(true)
    // Cleanup: the flag + its audit rows.
    await db.featureFlag.deleteMany({ where: { key } })
    await db.auditLog.deleteMany({
      where: { resourceType: "FEATURE_FLAG", resourceId: key },
    })
  })
})
