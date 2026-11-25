// Domain service gates (Phase 3) with a mocked Prisma client.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  domain: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
    findMany: vi.fn(),
  },
  domainVerification: {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
    findFirst: vi.fn(),
  },
  auditLog: { create: vi.fn() },
  $executeRaw: vi.fn(async () => 0),
  // Array form: the array already holds the mock calls' promises.
  // Callback form: run it against mockDb (tx IS mockDb) — the
  // service's advisory-lock transactions use this form.
  $transaction: vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: typeof mockDb) => unknown)(mockDb)
    }
    if (Array.isArray(arg)) return Promise.all(arg)
    return arg
  }),
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/domains/dns-verification", () => ({
  checkVerification: vi.fn(),
}))
// The plans module is mocked so the fail-closed limit check in
// createDomainForUser does not run the real entitlement lookup against
// this file's partial Prisma mock (same pattern as billing.test.ts).
const mockCheckLimitStrict = vi.hoisted(() =>
  vi.fn(async () => ({ allowed: true, limit: null, used: 0, remaining: null }))
)
vi.mock("@sendcms/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/plans")>()
  return { ...actual, checkLimitStrict: mockCheckLimitStrict }
})

import {
  createDomainForUser,
  deleteDomainForUser,
  isVerifiedOrigin,
  listDomainsPageForUser,
  setDomainStatusForUser,
  startVerificationForUser,
  verifyDomainForUser,
} from "@sendcms/domains"
import { checkVerification } from "@sendcms/domains/dns-verification"
import { ApiError } from "@sendcms/api-client"
import { Prisma } from "@sendcms/database"

function makeDomain(overrides: Record<string, unknown> = {}) {
  return {
    id: "dom-1",
    name: "example.com",
    domain: "example.com",
    status: "PENDING",
    verifiedAt: null,
    ownerId: "user-1",
    verifications: [
      {
        id: "ver-1",
        method: "DNS_TXT",
        challenge: "c".repeat(48),
        status: "PENDING",
        attempts: 0,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ],
    _count: { formLinks: 0 },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckLimitStrict.mockResolvedValue({
    allowed: true,
    limit: null,
    used: 0,
    remaining: null,
  })
  mockDb.user.findUnique.mockResolvedValue({
    id: "user-1",
    emailVerified: true,
  })
  mockDb.domain.findUnique.mockResolvedValue(null)
  mockDb.domain.findFirst.mockResolvedValue(makeDomain())
  mockDb.domain.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: "dom-1",
      ...args.data,
      verifications: [{ id: "ver-1", method: "DNS_TXT", status: "PENDING" }],
      _count: { formLinks: 0 },
    })
  )
  mockDb.domainVerification.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: "ver-2",
      ...args.data,
    })
  )
  mockDb.domainVerification.update.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: "ver-1",
      ...args.data,
    })
  )
  // DB-030: the pending re-read inside the locked startVerification
  // transaction returns the domain's pending verification by default.
  mockDb.domainVerification.findFirst.mockImplementation(async () => ({
    id: "ver-1",
    method: "DNS_TXT",
    challenge: "c".repeat(48),
    status: "PENDING",
    attempts: 0,
    expiresAt: new Date(Date.now() + 86_400_000),
  }))
  mockDb.auditLog.create.mockResolvedValue({})
})

async function expectApiError(promise: Promise<unknown>, status: number) {
  try {
    await promise
    throw new Error("expected an ApiError")
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(status)
  }
}

describe("createDomainForUser", () => {
  it("refuses an unverified email with 403", async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: "user-1",
      emailVerified: false,
    })
    await expectApiError(
      createDomainForUser("user-1", {
        domain: "example.com",
        method: "DNS_TXT",
      }),
      403
    )
  })

  it("refuses a duplicate domain with 409", async () => {
    mockDb.domain.findUnique.mockResolvedValue({ id: "dom-0" })
    await expectApiError(
      createDomainForUser("user-1", {
        domain: "example.com",
        method: "DNS_TXT",
      }),
      409
    )
  })

  it("maps a concurrent duplicate (P2002) to 409, never 500", async () => {
    mockDb.domain.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "7",
      })
    )
    await expectApiError(
      createDomainForUser("user-1", {
        domain: "example.com",
        method: "DNS_TXT",
      }),
      409
    )
  })

  it("normalizes the domain and creates a 48-char challenge", async () => {
    const created = await createDomainForUser("user-1", {
      domain: "https://www.EXAMPLE.com/blog",
      method: "DNS_TXT",
    })
    expect(created.domain).toBe("example.com")
    const createArg = mockDb.domain.create.mock.calls[0][0] as {
      data: { verifications: { create: { challenge: string } } }
    }
    expect(createArg.data.verifications.create.challenge).toHaveLength(48)
    expect(mockDb.auditLog.create).toHaveBeenCalled()
  })
})

describe("startVerificationForUser", () => {
  it("returns the pending verification unchanged when the method matches", async () => {
    const result = await startVerificationForUser("user-1", "dom-1", {
      method: "DNS_TXT",
    })
    expect(result.id).toBe("ver-1")
    expect(mockDb.domainVerification.update).not.toHaveBeenCalled()
    expect(mockDb.domainVerification.create).not.toHaveBeenCalled()
  })

  it("switches method in place and keeps the same challenge", async () => {
    await startVerificationForUser("user-1", "dom-1", { method: "FILE" })
    const updateArg = mockDb.domainVerification.update.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(updateArg.data).toEqual({ method: "FILE" })
    expect(mockDb.domainVerification.create).not.toHaveBeenCalled()
  })

  it("creates a fresh verification when none is pending", async () => {
    mockDb.domainVerification.findFirst.mockResolvedValueOnce(null)
    const result = await startVerificationForUser("user-1", "dom-1", {
      method: "DNS_TXT",
    })
    expect(result.id).toBe("ver-2")
    expect(mockDb.domainVerification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ domainId: "dom-1" }),
      })
    )
  })

  it("refuses to verify an already verified domain", async () => {
    mockDb.domain.findFirst.mockResolvedValue(
      makeDomain({ status: "VERIFIED" })
    )
    await expectApiError(
      startVerificationForUser("user-1", "dom-1", { method: "FILE" }),
      409
    )
  })
})

describe("verifyDomainForUser", () => {
  it("returns verified without a DNS check when already verified", async () => {
    mockDb.domain.findFirst.mockResolvedValue(
      makeDomain({ status: "VERIFIED" })
    )
    const result = await verifyDomainForUser("user-1", "dom-1")
    expect(result.verified).toBe(true)
    expect(checkVerification).not.toHaveBeenCalled()
  })

  it("expires the challenge with 410 when past its TTL", async () => {
    mockDb.domain.findFirst.mockResolvedValue(
      makeDomain({
        verifications: [
          {
            id: "ver-1",
            method: "DNS_TXT",
            challenge: "c".repeat(48),
            status: "PENDING",
            attempts: 0,
            expiresAt: new Date(Date.now() - 1000),
          },
        ],
      })
    )
    await expectApiError(verifyDomainForUser("user-1", "dom-1"), 410)
    expect(mockDb.domainVerification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "EXPIRED" }),
      })
    )
  })

  it("marks the domain verified on a passing check", async () => {
    vi.mocked(checkVerification).mockResolvedValue({ ok: true })
    const result = await verifyDomainForUser("user-1", "dom-1")
    expect(result.verified).toBe(true)
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1)
    expect(mockDb.auditLog.create).toHaveBeenCalled()
    // DSH-106: the nested verification is patched to the new values,
    // not the pre-check snapshot.
    expect(result.domain.verifications[0]?.status).toBe("VERIFIED")
    expect(result.domain.verifications[0]?.verifiedAt).toBeInstanceOf(Date)
  })

  it("counts a failed check and returns the reason", async () => {
    vi.mocked(checkVerification).mockResolvedValue({
      ok: false,
      reason: "TXT record not found yet.",
    })
    mockDb.domainVerification.update.mockResolvedValueOnce({
      id: "ver-1",
      attempts: 1,
      status: "PENDING",
    })
    const result = await verifyDomainForUser("user-1", "dom-1")
    expect(result.verified).toBe(false)
    expect(result.attempts).toBe(1)
    expect(result.reason).toBe("TXT record not found yet.")
    expect(mockDb.$transaction).not.toHaveBeenCalled()
    // DB-030: the counter moves by an atomic increment, not a
    // read-then-write.
    expect(mockDb.domainVerification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attempts: { increment: 1 } }),
      })
    )
    // DSH-106: the nested verification matches the top-level count.
    expect(result.domain.verifications[0]?.attempts).toBe(result.attempts)
  })

  it("fails the verification on the 10th failed attempt", async () => {
    vi.mocked(checkVerification).mockResolvedValue({
      ok: false,
      reason: "nope",
    })
    mockDb.domain.findFirst.mockResolvedValue(
      makeDomain({
        verifications: [
          {
            id: "ver-1",
            method: "DNS_TXT",
            challenge: "c".repeat(48),
            status: "PENDING",
            attempts: 9,
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        ],
      })
    )
    mockDb.domainVerification.update.mockResolvedValueOnce({
      id: "ver-1",
      attempts: 10,
      status: "PENDING",
    })
    const result = await verifyDomainForUser("user-1", "dom-1")
    expect(result.verified).toBe(false)
    expect(result.attempts).toBe(10)
    expect(mockDb.domainVerification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attempts: { increment: 1 } }),
      })
    )
    expect(mockDb.domainVerification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED" }),
      })
    )
    // DSH-106: the nested row shows FAILED with the new count.
    expect(result.domain.verifications[0]?.attempts).toBe(10)
    expect(result.domain.verifications[0]?.status).toBe("FAILED")
  })

  it("throws 404 when there is no pending verification", async () => {
    mockDb.domain.findFirst.mockResolvedValue(makeDomain({ verifications: [] }))
    await expectApiError(verifyDomainForUser("user-1", "dom-1"), 404)
  })
})

describe("isVerifiedOrigin (SDK-021 / SEC-207)", () => {
  it("returns true only for a VERIFIED domain row", async () => {
    mockDb.domain.findFirst.mockResolvedValueOnce({ id: "dom-1" })
    await expect(isVerifiedOrigin("https://www.example.com")).resolves.toBe(
      true
    )
    expect(mockDb.domain.findFirst).toHaveBeenCalledWith({
      where: { domain: "example.com", status: "VERIFIED" },
      select: { id: true },
    })
    mockDb.domain.findFirst.mockResolvedValueOnce(null)
    await expect(isVerifiedOrigin("https://evil.example")).resolves.toBe(false)
  })

  it("returns false without a DB lookup for null or unparseable origins", async () => {
    mockDb.domain.findFirst.mockClear()
    await expect(isVerifiedOrigin(null)).resolves.toBe(false)
    await expect(isVerifiedOrigin("not a url")).resolves.toBe(false)
    expect(mockDb.domain.findFirst).not.toHaveBeenCalled()
  })
})

describe("setDomainStatusForUser / deleteDomainForUser", () => {
  it("refuses to suspend an already suspended domain", async () => {
    mockDb.domain.findFirst.mockResolvedValue(
      makeDomain({ status: "SUSPENDED" })
    )
    await expectApiError(
      setDomainStatusForUser("user-1", "dom-1", { action: "suspend" }),
      409
    )
  })

  it("refuses to reactivate a domain that is not suspended", async () => {
    await expectApiError(
      setDomainStatusForUser("user-1", "dom-1", { action: "reactivate" }),
      409
    )
  })

  it("refuses to delete a domain linked to forms", async () => {
    mockDb.domain.findFirst.mockResolvedValue(
      makeDomain({ _count: { formLinks: 2 } })
    )
    await expectApiError(
      deleteDomainForUser("user-1", "dom-1", "example.com"),
      409
    )
    expect(mockDb.domain.delete).not.toHaveBeenCalled()
  })

  it("refuses to delete without the matching confirmation token", async () => {
    await expectApiError(
      deleteDomainForUser("user-1", "dom-1", "wrong.com"),
      422
    )
    await expectApiError(deleteDomainForUser("user-1", "dom-1", ""), 422)
    expect(mockDb.domain.delete).not.toHaveBeenCalled()
  })

  it("deletes an unlinked domain", async () => {
    await deleteDomainForUser("user-1", "dom-1", "example.com")
    expect(mockDb.domain.delete).toHaveBeenCalledWith({
      where: { id: "dom-1" },
    })
  })
})

describe("listDomainsPageForUser (DSH-107)", () => {
  it("pages, searches, and clamps perPage at the service", async () => {
    mockDb.domain.count.mockResolvedValue(3)
    mockDb.domain.findMany.mockResolvedValue([
      makeDomain({ id: "dom-2", domain: "second.example" }),
    ])
    const page = await listDomainsPageForUser("user-1", {
      search: "second",
      page: 2,
      perPage: 1,
    })
    expect(page.total).toBe(3)
    expect(page.page).toBe(2)
    expect(page.perPage).toBe(1)
    expect(page.items).toHaveLength(1)
    expect(mockDb.domain.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { name: { contains: "second", mode: "insensitive" } },
            { domain: { contains: "second", mode: "insensitive" } },
          ]),
        }),
        skip: 1,
        take: 1,
      })
    )
    const huge = await listDomainsPageForUser("user-1", { perPage: 500 })
    expect(huge.perPage).toBe(100)
    expect(mockDb.domain.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 })
    )
  })
})
