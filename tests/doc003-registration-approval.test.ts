// DOC-003 — registration toggle + manual-approval queue: regression
// tests (plan §9, tests 1–14).
//
// LIVE-DB SUITE. Unlike the mocked service suites, these tests drive the
// REAL Better Auth instance (`createSendcmsAuth`) through its in-process
// HTTP handler (`betterAuth.handler`) against a real Postgres, plus the
// real `approveUser` / `rejectUser` / `restoreUser` services — so the
// `user.create.before` and `session.create.before` hooks, the
// PLATFORM_OWNER promotion, and the conditional `transitionUserStatus`
// are all exercised, not mocked.
//
// Gated like tests/wave5-stream-c-live-db.test.ts: SKIPPED unless
// DOC003_LIVE_DB=1 and DATABASE_URL points at the dedicated scratch
// database `sendcms_doc003_d` (created fresh for this suite with
// `prisma migrate deploy`, 57/57 migrations). The gate refuses any
// other database name, so these tests can never run against the real
// dev DB. Run:
//   DOC003_LIVE_DB=1 DATABASE_URL='postgresql://root@localhost/sendcms_doc003_d?host=/var/run/postgresql&sslmode=disable' \
//     pnpm vitest run tests/doc003-registration-approval.test.ts
//
// Honest limits (stated, not hidden):
// - No live OAuth provider exists in dev, so test 3 calls the REAL
//   `user.create.before` function off the live instance's options
//   (the same function `createOAuthUser` invokes via `createWithHooks`
//   — Stream A, findings F3) instead of a live Google/GitHub sign-up.
// - No mail provider is configured in dev, so verification tokens are
//   minted in-test with the exact HS256 shape the library signs
//   (`createEmailVerificationToken` → `signJWT`: HS256, iat + exp, the
//   Better Auth secret). The REAL verify-email endpoint validates the
//   token; only the delivery step is substituted. Live email sending
//   is owed in Phase 17.
// - The `auth()` helper reads its session cookie from `next/headers`,
//   which throws outside a request scope — the test doubles ONLY that
//   transport (`vi.mock("next/headers")` returning a caller-set
//   Headers object). The helper itself, the session hook, and the
//   session lookup are all real.
import { createHmac, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { db } from "@sendcms/database"
import {
  createSendcmsAuth,
  isRegistrationEnabled,
  type AdminSession,
} from "@sendcms/auth"
import { approveUser, rejectUser, restoreUser } from "@sendcms/admin-users"
import { SYSTEM_FLAGS, deleteFlag } from "@sendcms/platform-ops"

// `next/headers` transport double (see header): the caller sets
// `mockHeaders.headers` per check; the `auth()` helper under test is
// real, only the request-scope header source is stubbed.
const mockHeaders = vi.hoisted(() => ({ headers: new Headers() }))
vi.mock("next/headers", () => ({
  headers: async () => mockHeaders.headers,
}))

const root = process.cwd()
const read = (rel: string) => readFileSync(path.join(root, rel), "utf-8")

const DB_URL = process.env.DATABASE_URL ?? ""
const enabled =
  process.env.DOC003_LIVE_DB === "1" && DB_URL.includes("sendcms_doc003_d")

const run = `d3${Date.now().toString(36)}${Math.random()
  .toString(36)
  .slice(2, 6)}`
let counter = 0
const PASSWORD = "Doc003Pass123"
const BASE_URL = "http://localhost:3000"

function freshEmail(tag: string): string {
  counter += 1
  return `doc003-${run}-${tag}-${counter}@example.com`
}

type AuthResponse = {
  token?: unknown
  user?: {
    id?: string
    status?: string
    platformRole?: string
    emailVerified?: boolean
  }
  status?: boolean
  message?: string
  code?: string
}

type AuthCall = {
  status: number
  json: AuthResponse
  setCookie: string | null
  setCookies: string[]
}

let betterAuth: ReturnType<typeof createSendcmsAuth>["betterAuth"]
let auth: ReturnType<typeof createSendcmsAuth>["auth"]
let secret = ""

async function authRequest(
  path: string,
  method: "GET" | "POST",
  body?: unknown
): Promise<AuthCall> {
  const res = await betterAuth.handler(
    new Request(`${BASE_URL}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  )
  const text = await res.text()
  let json: AuthResponse = {}
  try {
    json = JSON.parse(text) as AuthResponse
  } catch {
    json = { message: text.slice(0, 200) }
  }
  return {
    status: res.status,
    json,
    setCookie: res.headers.get("set-cookie"),
    setCookies: res.headers.getSetCookie(),
  }
}

async function signUp(tag: string) {
  const email = freshEmail(tag)
  const res = await authRequest("/api/auth/sign-up/email", "POST", {
    name: `Doc003 ${tag}`,
    email,
    password: PASSWORD,
  })
  const row = await db.user.findUnique({ where: { email } })
  return { email, res, row }
}

async function signIn(email: string) {
  return authRequest("/api/auth/sign-in/email", "POST", {
    email,
    password: PASSWORD,
  })
}

// Mint the verification token the way Better Auth does
// (`createEmailVerificationToken` → `signJWT`: HS256, iat + exp, the
// Better Auth secret). The token is validated by the REAL
// verify-email endpoint — see the header note.
function mintVerificationToken(email: string, userId: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url"
  )
  const payload = Buffer.from(
    JSON.stringify({
      email: email.toLowerCase(),
      userId,
      iat: now,
      exp: now + 60 * 60 * 24,
    })
  ).toString("base64url")
  const sig = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url")
  return `${header}.${payload}.${sig}`
}

async function verifyEmail(email: string, userId: string) {
  const token = mintVerificationToken(email, userId)
  return authRequest(
    `/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    "GET"
  )
}

async function setRegistration(on: boolean) {
  await db.featureFlag.update({
    where: { key: "registration" },
    data: { isEnabled: on },
  })
}

async function sessionCount(userId: string) {
  return db.session.count({ where: { userId } })
}

async function auditEvents(resourceId: string): Promise<string[]> {
  const rows = await db.auditLog.findMany({
    where: { resourceId },
    select: { detail: true },
  })
  return rows
    .map((r) => (r.detail as { event?: string } | null)?.event)
    .filter((e): e is string => typeof e === "string")
}

function makeOwnerSession(owner: {
  id: string
  name: string
  email: string
}): AdminSession {
  return {
    user: {
      id: owner.id,
      name: owner.name,
      email: owner.email,
      image: null,
      platformRole: "PLATFORM_OWNER",
      status: "ACTIVE",
      adminRole: null,
      emailVerified: true,
    },
    session: {
      id: `sess-${run}`,
      userId: owner.id,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  }
}

async function countAll() {
  return {
    user: await db.user.count(),
    session: await db.session.count(),
    account: await db.account.count(),
    verification: await db.verification.count(),
    emailJob: await db.emailJob.count(),
    auditLog: await db.auditLog.count(),
    featureFlag: await db.featureFlag.count(),
  }
}

describe.skipIf(!enabled)(
  "DOC-003 registration toggle + approval queue (live DB)",
  () => {
    let owner: { id: string; name: string; email: string } | null = null
    let ownerSession: AdminSession | null = null
    let baseline: Awaited<ReturnType<typeof countAll>> | null = null

    function requireOwner(): AdminSession {
      if (!ownerSession) throw new Error("owner not created (test 11)")
      return ownerSession
    }

    beforeAll(async () => {
      // Defense in depth: the gate already requires the scratch DB
      // name in DATABASE_URL — prove it again from the server side.
      const dbName = await db.$queryRaw<{ current_database: string }[]>`
        SELECT current_database()`
      expect(dbName[0]?.current_database).toBe("sendcms_doc003_d")

      process.env.BETTER_AUTH_SECRET ??=
        "doc003-test-secret-must-be-at-least-32-chars"
      process.env.BETTER_AUTH_URL ??= BASE_URL
      process.env.TRUSTED_ORIGINS ??=
        "http://localhost:3002,http://localhost:3006"
      secret = process.env.BETTER_AUTH_SECRET

      // Fresh start: the DB is scratch-only for this suite, so wipe
      // the suite's tables (a previous failed run must not leave a
      // PLATFORM_OWNER behind — test 11 needs a first sign-up).
      await db.session.deleteMany()
      await db.account.deleteMany()
      await db.verification.deleteMany()
      await db.emailJob.deleteMany()
      await db.auditLog.deleteMany()
      await db.user.deleteMany()
      baseline = await countAll()
      // The migration seed must have created the flag enabled; a
      // missing row fails loudly here instead of silently closing
      // registration for every test below.
      await db.featureFlag.update({
        where: { key: "registration" },
        data: { isEnabled: true },
      })

      const created = createSendcmsAuth()
      betterAuth = created.betterAuth
      auth = created.auth
    }, 60_000)

    afterAll(async () => {
      await db.session.deleteMany()
      await db.account.deleteMany()
      await db.verification.deleteMany()
      await db.emailJob.deleteMany()
      await db.auditLog.deleteMany()
      await db.user.deleteMany()
      const after = await countAll()
      expect(after.user).toBe(baseline?.user ?? 0)
      expect(after.session).toBe(baseline?.session ?? 0)
      expect(after.account).toBe(baseline?.account ?? 0)
      expect(after.verification).toBe(baseline?.verification ?? 0)
      expect(after.emailJob).toBe(baseline?.emailJob ?? 0)
      expect(after.auditLog).toBe(baseline?.auditLog ?? 0)
      expect(after.featureFlag).toBe(baseline?.featureFlag)
      await db.$disconnect()
    }, 60_000)

    // Test 11 runs FIRST: beforeAll wiped all users, so this is the
    // first sign-up on the fresh DB — the one that must become the
    // PLATFORM_OWNER. Every later test uses that owner as its actor.
    it("11 — first user on a fresh DB is ACTIVE + PLATFORM_OWNER; the second is PENDING_APPROVAL", async () => {
      const first = await signUp("owner")
      expect(first.res.status).toBe(200)
      expect(first.row?.status).toBe("ACTIVE")
      expect(first.row?.platformRole).toBe("PLATFORM_OWNER")
      expect(first.row?.emailVerified).toBe(false)
      // Store the owner BEFORE the snapshot assertions below: if a
      // later assertion in this test fails, the dependent tests must
      // still run against their own logic instead of failing in
      // requireOwner() (fault-injection attribution stays per-test).
      owner = {
        id: first.row?.id ?? "",
        name: "Doc003 owner",
        email: first.email,
      }
      ownerSession = makeOwnerSession(owner)
      // The assertion is on the DB ROW, not the response body: the
      // sign-up response still shows the pre-promotion snapshot
      // (Stream A probe) — PENDING_APPROVAL / PLATFORM_USER.
      expect(first.res.json.user?.status).toBe("PENDING_APPROVAL")
      expect(first.res.json.user?.platformRole).toBe("PLATFORM_USER")
      expect(await auditEvents(first.row?.id ?? "?")).toContain(
        "platform-owner-promotion"
      )

      const second = await signUp("second")
      expect(second.res.status).toBe(200)
      expect(second.res.json.user?.status).toBe("PENDING_APPROVAL")
      expect(second.row?.status).toBe("PENDING_APPROVAL")
      expect(second.row?.platformRole).toBe("PLATFORM_USER")
      expect(await sessionCount(second.row?.id ?? "?")).toBe(0)
    }, 30_000)

    it("1 — sign-up with the flag ON creates PENDING_APPROVAL, unverified, no session", async () => {
      expect(await isRegistrationEnabled()).toBe(true)
      const { res, row } = await signUp("t1")
      expect(res.status).toBe(200)
      expect(res.json.token).toBeNull()
      expect(res.json.user?.status).toBe("PENDING_APPROVAL")
      expect(row?.status).toBe("PENDING_APPROVAL")
      expect(row?.emailVerified).toBe(false)
      expect(await sessionCount(row?.id ?? "?")).toBe(0)
    }, 30_000)

    it("2 — sign-up with the flag OFF is refused 400 FAILED_TO_CREATE_USER and creates no user row", async () => {
      await setRegistration(false)
      try {
        expect(await isRegistrationEnabled()).toBe(false)
        const email = freshEmail("t2")
        const res = await authRequest("/api/auth/sign-up/email", "POST", {
          name: "Doc003 t2",
          email,
          password: PASSWORD,
        })
        expect(res.status).toBe(400)
        expect(res.json).toMatchObject({
          code: "FAILED_TO_CREATE_USER",
          message: "Failed to create user",
        })
        expect(await db.user.findUnique({ where: { email } })).toBeNull()
      } finally {
        await setRegistration(true)
      }
      expect(await isRegistrationEnabled()).toBe(true)
    }, 30_000)

    it("3 — OAuth path: the real user.create.before hook lands ON sign-ups PENDING_APPROVAL and refuses OFF ones", async () => {
      // The hook function is read off the LIVE instance's options —
      // the same function `createUser` and `createOAuthUser` invoke
      // through `createWithHooks` (Stream A, F3). No live OAuth
      // provider exists in dev, so there is no live Google/GitHub
      // sign-up to drive; this pins the hook the OAuth path runs.
      const before = (
        betterAuth as unknown as {
          options?: {
            databaseHooks?: {
              user?: {
                create?: {
                  before?: (user: unknown, ctx?: unknown) => Promise<unknown>
                }
              }
            }
          }
        }
      ).options?.databaseHooks?.user?.create?.before
      expect(typeof before).toBe("function")
      const fakeUser = {
        id: "hook-user",
        name: "Hook User",
        email: "hook-user@example.com",
        emailVerified: false,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      await setRegistration(true)
      const on = await before?.(fakeUser)
      expect(on).toEqual({
        data: expect.objectContaining({
          ...fakeUser,
          status: "PENDING_APPROVAL",
        }),
      })
      await setRegistration(false)
      try {
        await expect(before?.(fakeUser)).resolves.toBe(false)
      } finally {
        await setRegistration(true)
      }
    }, 30_000)

    it("4 — sign-in while PENDING_APPROVAL is refused: no session row, no Set-Cookie, FAILED_TO_CREATE_SESSION", async () => {
      const { email, row } = await signUp("t4")
      const userId = row?.id ?? ""
      // Email must verify first: an unverified sign-in fails with
      // EMAIL_NOT_VERIFIED before any session is attempted.
      const ver = await verifyEmail(email, userId)
      expect(ver.status).toBe(500)
      expect(ver.json).toMatchObject({ code: "FAILED_TO_CREATE_SESSION" })
      expect(
        (await db.user.findUnique({ where: { id: userId } }))?.emailVerified
      ).toBe(true)

      // (a) The real session.create.before hook refuses the session.
      const si = await signIn(email)
      expect(si.status).toBe(401)
      expect(si.json).toMatchObject({ code: "FAILED_TO_CREATE_SESSION" })
      expect(si.setCookies).toHaveLength(0)
      expect(si.setCookie).toBeNull()
      expect(await sessionCount(userId)).toBe(0)

      // (b) Second layer — the real auth() helper: a session row
      // created before the hook (direct insert, simulating a legacy
      // row) still reads as signed out for a pending user.
      const pendingToken = randomBytes(32).toString("hex")
      await db.session.create({
        data: {
          token: pendingToken,
          userId,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      })
      mockHeaders.headers = new Headers({
        cookie: `better-auth.session_token=${pendingToken}`,
      })
      await expect(auth()).resolves.toBeNull()

      // Positive control: the ACTIVE owner's session resolves.
      const ownerRow = await db.user.findUnique({
        where: { id: owner?.id ?? "?" },
      })
      if (!ownerRow?.emailVerified) {
        const ownerVer = await verifyEmail(owner?.email ?? "", owner?.id ?? "")
        expect(ownerVer.status).toBe(200)
      }
      const ownerSignIn = await signIn(owner?.email ?? "")
      expect(ownerSignIn.status).toBe(200)
      expect(ownerSignIn.setCookies.length).toBeGreaterThan(0)
      const cookie = ownerSignIn.setCookies[0]?.split(";")[0] ?? ""
      expect(cookie).toContain("better-auth.session_token=")
      mockHeaders.headers = new Headers({ cookie })
      const session = await auth()
      expect(session?.user.id).toBe(owner?.id)
      expect(session?.user.status).toBe("ACTIVE")
    }, 30_000)

    it("5 — verify-email while pending: email becomes verified, status stays PENDING_APPROVAL, still no session", async () => {
      const { email, row } = await signUp("t5")
      const userId = row?.id ?? ""
      const ver = await verifyEmail(email, userId)
      expect(ver.status).toBe(500)
      expect(ver.json).toMatchObject({ code: "FAILED_TO_CREATE_SESSION" })
      const after = await db.user.findUnique({ where: { id: userId } })
      expect(after?.emailVerified).toBe(true)
      expect(after?.status).toBe("PENDING_APPROVAL")
      expect(await sessionCount(userId)).toBe(0)
    }, 30_000)

    it("6 — approve: ACTIVE + user-approved audit + ACCOUNT_APPROVED email job; sign-in then works", async () => {
      const { email, row } = await signUp("t6")
      const userId = row?.id ?? ""
      await verifyEmail(email, userId)
      const approved = await approveUser(requireOwner(), userId, {
        reason: "Looks good",
      })
      expect(approved.status).toBe("ACTIVE")
      const after = await db.user.findUnique({ where: { id: userId } })
      expect(after?.status).toBe("ACTIVE")
      expect(after?.statusReason).toBeNull()
      expect(await auditEvents(userId)).toContain("user-approved")
      const jobs = await db.emailJob.findMany({
        where: { ownerId: userId, type: "ACCOUNT_APPROVED" },
      })
      expect(jobs).toHaveLength(1)
      expect(jobs[0]?.status).toBe("PENDING")
      const si = await signIn(email)
      expect(si.status).toBe(200)
      expect(si.setCookies.length).toBeGreaterThan(0)
      expect(await sessionCount(userId)).toBeGreaterThan(0)
    }, 30_000)

    it("7 — reject: DISABLED with the reason, user-rejected audit, sign-in refused, restore returns ACTIVE", async () => {
      const { email, row } = await signUp("t7")
      const userId = row?.id ?? ""
      await verifyEmail(email, userId)
      const rejected = await rejectUser(requireOwner(), userId, {
        reason: "Not a fit",
      })
      expect(rejected.status).toBe("DISABLED")
      const after = await db.user.findUnique({ where: { id: userId } })
      expect(after?.status).toBe("DISABLED")
      expect(after?.statusReason).toBe("Not a fit")
      expect(await auditEvents(userId)).toContain("user-rejected")
      const si = await signIn(email)
      expect(si.status).toBe(401)
      expect(si.json).toMatchObject({ code: "FAILED_TO_CREATE_SESSION" })
      expect(await sessionCount(userId)).toBe(0)
      const restored = await restoreUser(requireOwner(), userId, {})
      expect(restored.status).toBe("ACTIVE")
      const si2 = await signIn(email)
      expect(si2.status).toBe(200)
      expect(await sessionCount(userId)).toBeGreaterThan(0)
    }, 30_000)

    it("8 — approve/reject on a non-pending user 409s (ACTIVE, SUSPENDED, DISABLED, already-approved, already-rejected)", async () => {
      const actor = requireOwner()
      async function fixture(
        tag: string,
        status: "ACTIVE" | "SUSPENDED" | "DISABLED",
        statusReason?: string
      ) {
        // Direct Prisma, bypassing the hooks (like the seed) — the
        // fixture states are the point, not the sign-up path.
        return db.user.create({
          data: {
            name: `Doc003 ${tag}`,
            email: freshEmail(tag),
            emailVerified: true,
            status,
            statusReason: statusReason ?? null,
            platformRole: "PLATFORM_USER",
          },
          select: { id: true },
        })
      }
      for (const [tag, status] of [
        ["t8-active", "ACTIVE"],
        ["t8-suspended", "SUSPENDED"],
        ["t8-disabled", "DISABLED"],
      ] as const) {
        const target = await fixture(tag, status)
        await expect(approveUser(actor, target.id, {})).rejects.toMatchObject({
          status: 409,
        })
        await expect(
          rejectUser(actor, target.id, { reason: "x" })
        ).rejects.toMatchObject({ status: 409 })
      }
      // Already-approved: approve once (applies), approve again (409).
      const approved = await signUp("t8-approved")
      await approveUser(actor, approved.row?.id ?? "", {})
      await expect(
        approveUser(actor, approved.row?.id ?? "", {})
      ).rejects.toMatchObject({ status: 409 })
      // Already-rejected: reject once (applies), reject again (409);
      // approving a rejected-with-reason user 409s with the restore
      // path named.
      const rejected = await signUp("t8-rejected")
      await rejectUser(actor, rejected.row?.id ?? "", {
        reason: "Rejected earlier",
      })
      await expect(
        rejectUser(actor, rejected.row?.id ?? "", { reason: "x" })
      ).rejects.toMatchObject({ status: 409 })
      await expect(
        approveUser(actor, rejected.row?.id ?? "", {})
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("Restore"),
      })
    }, 30_000)

    it("9 — approve race: two concurrent approves — one applies, the other 409s, exactly one audit row", async () => {
      const actor = requireOwner()
      const { row } = await signUp("t9")
      const userId = row?.id ?? ""
      const [first, second] = await Promise.allSettled([
        approveUser(actor, userId, { reason: "Race A" }),
        approveUser(actor, userId, { reason: "Race B" }),
      ])
      const fulfilled = [first, second].filter((r) => r.status === "fulfilled")
      const rejected = [first, second].filter((r) => r.status === "rejected")
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        status: 409,
      })
      const final = await db.user.findUnique({ where: { id: userId } })
      expect(final?.status).toBe("ACTIVE")
      const events = (await auditEvents(userId)).filter(
        (e) => e === "user-approved"
      )
      expect(events).toHaveLength(1)
    }, 30_000)

    it("10 — a pre-existing ACTIVE user signs in normally after the migration", async () => {
      // The owner from test 11 is the pre-existing ACTIVE user.
      const ownerRow = await db.user.findUnique({
        where: { id: owner?.id ?? "?" },
      })
      expect(ownerRow?.status).toBe("ACTIVE")
      if (!ownerRow?.emailVerified) {
        const ver = await verifyEmail(owner?.email ?? "", owner?.id ?? "")
        expect(ver.status).toBe(200)
      }
      const si = await signIn(owner?.email ?? "")
      expect(si.status).toBe(200)
      expect(si.json.user?.status).toBe("ACTIVE")
      expect(si.setCookies.length).toBeGreaterThan(0)
      expect(await sessionCount(owner?.id ?? "?")).toBeGreaterThan(0)
    }, 30_000)

    it("12 — flag seeded enabled; deleting the system flag is refused 422", async () => {
      const flag = await db.featureFlag.findUnique({
        where: { key: "registration" },
      })
      expect(flag).not.toBeNull()
      expect(flag?.id).toBe("seed-flag-registration")
      expect(flag?.isEnabled).toBe(true)
      expect(SYSTEM_FLAGS).toContain("registration")
      await expect(
        deleteFlag(requireOwner(), "registration", { reason: "test" })
      ).rejects.toMatchObject({ status: 422 })
      // The client SYSTEM_FLAG_KEYS parity is already pinned by the
      // wave5-stream-c ADM-092 assertion (extended to three keys by
      // Stream C) — not duplicated here.
    }, 30_000)

    it("13 — toggle OFF after a user is pending: the pending user stays pending; new sign-ups are refused", async () => {
      const { row } = await signUp("t13")
      const userId = row?.id ?? ""
      await setRegistration(false)
      try {
        const after = await db.user.findUnique({ where: { id: userId } })
        expect(after?.status).toBe("PENDING_APPROVAL")
        const email = freshEmail("t13b")
        const res = await authRequest("/api/auth/sign-up/email", "POST", {
          name: "Doc003 t13b",
          email,
          password: PASSWORD,
        })
        expect(res.status).toBe(400)
        expect(res.json).toMatchObject({ code: "FAILED_TO_CREATE_USER" })
        expect(await db.user.findUnique({ where: { email } })).toBeNull()
      } finally {
        await setRegistration(true)
      }
    }, 30_000)

    it("14 — toggle default ON: with the flag row present and enabled, sign-up proceeds", async () => {
      const flag = await db.featureFlag.findUnique({
        where: { key: "registration" },
      })
      expect(flag?.isEnabled).toBe(true)
      const { row } = await signUp("t14")
      expect(row?.status).toBe("PENDING_APPROVAL")
    }, 30_000)
  }
)

// Static pins — run on every `pnpm test`, no DB needed.
describe("DOC-003 — static pins (no DB)", () => {
  it("GAP 2: the sign-up form maps FAILED_TO_CREATE_USER to 'Registration is currently closed.'", () => {
    const form = read("apps/dashboard/app/(auth)/sign-up/sign-up-form.tsx")
    expect(form).toContain('code === "FAILED_TO_CREATE_USER"')
    expect(form).toContain('"Registration is currently closed."')
    // The generic fallback stays for every other failure — the
    // mapping is code-specific, not a blanket replace.
    expect(form).toContain('error.message ?? "Couldn\'t create the account."')
  })

  it("the migration seeds the registration flag enabled", () => {
    const migration = read(
      "packages/database/prisma/migrations/20261128091504_doc003_registration_approval/migration.sql"
    )
    expect(migration).toContain("seed-flag-registration")
    expect(migration).toContain("'registration'")
    expect(migration).toContain("true")
    expect(migration).toContain("PENDING_APPROVAL")
    expect(migration).toContain("ACCOUNT_APPROVED")
  })
})
