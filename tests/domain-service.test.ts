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
  },
  domainVerification: { create: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/domains/dns-verification", () => ({
  checkVerification: vi.fn(),
}))

import {
  createDomainForUser,
  deleteDomainForUser,
  setDomainStatusForUser,
  startVerificationForUser,
  verifyDomainForUser,
} from "@sendcms/domains"
import { checkVerification } from "@sendcms/domains/dns-verification"
import { ApiError } from "@sendcms/api-client"

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
  })

  it("counts a failed check and returns the reason", async () => {
    vi.mocked(checkVerification).mockResolvedValue({
      ok: false,
      reason: "TXT record not found yet.",
    })
    const result = await verifyDomainForUser("user-1", "dom-1")
    expect(result.verified).toBe(false)
    expect(result.attempts).toBe(1)
    expect(result.reason).toBe("TXT record not found yet.")
    expect(mockDb.$transaction).not.toHaveBeenCalled()
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
    const result = await verifyDomainForUser("user-1", "dom-1")
    expect(result.verified).toBe(false)
    expect(result.attempts).toBe(10)
    expect(mockDb.domainVerification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attempts: 10, status: "FAILED" }),
      })
    )
  })

  it("throws 404 when there is no pending verification", async () => {
    mockDb.domain.findFirst.mockResolvedValue(makeDomain({ verifications: [] }))
    await expectApiError(verifyDomainForUser("user-1", "dom-1"), 404)
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
    await expectApiError(deleteDomainForUser("user-1", "dom-1"), 409)
    expect(mockDb.domain.delete).not.toHaveBeenCalled()
  })

  it("deletes an unlinked domain", async () => {
    await deleteDomainForUser("user-1", "dom-1")
    expect(mockDb.domain.delete).toHaveBeenCalledWith({
      where: { id: "dom-1" },
    })
  })
})
