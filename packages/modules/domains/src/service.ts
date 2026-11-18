import { randomBytes } from "node:crypto"
import {
  AuditAction,
  AuditResource,
  DomainStatus,
  DomainVerificationMethod,
  DomainVerificationStatus,
  db,
} from "@sendcms/database"

import { ApiError } from "@sendcms/shared"

import { checkVerification } from "./dns-verification"
import type {
  CreateDomainInput,
  DomainActionInput,
  ReverifyDomainInput,
} from "./validators"

// Domain ownership (Phase 3). One record per normalized hostname
// (Domain.domain is @unique). A domain can only receive submissions once
// its owner proves control of it — DNS TXT by default, meta tag or a
// verification file as alternatives. Verification is gated on the owner's
// email being verified (the account page shows the same lock).

export const MAX_VERIFICATION_ATTEMPTS = 10
export const CHALLENGE_TTL_DAYS = 7

const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

// Lowercase, strip scheme/userinfo/port/path/query/fragment, strip a
// trailing dot and a leading www. Subdomains other than www are kept:
// blog.example.com is a different host from example.com.
export function normalizeDomain(raw: string): string {
  let host = raw.trim().toLowerCase()
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
  host = host.replace(/^\/\//, "")
  // Userinfo (user@host) — keep the host part after the last @.
  const at = host.lastIndexOf("@")
  if (at !== -1) host = host.slice(at + 1)
  host = host.split(/[/:?#]/, 1)[0] ?? ""
  host = host.replace(/\.$/, "")
  host = host.replace(/^www\./, "")
  return host
}

export function assertValidDomain(raw: string): string {
  const domain = normalizeDomain(raw)
  if (!HOSTNAME_RE.test(domain)) {
    throw new ApiError(
      `"${raw.trim()}" is not a valid public domain name (e.g. example.com).`,
      400
    )
  }
  return domain
}

// 36 random bytes = 48 base64url chars (288 bits): long enough that the
// value is practically unique forever (never collides with another
// site's value).
export function newChallenge(): string {
  return randomBytes(36).toString("base64url")
}

function challengeExpiresAt(): Date {
  return new Date(Date.now() + CHALLENGE_TTL_DAYS * 24 * 60 * 60 * 1000)
}

async function logDomainAudit(
  userId: string,
  action: AuditAction,
  domainId: string,
  domain: string
) {
  try {
    await db.auditLog.create({
      data: {
        action,
        resourceType: AuditResource.DOMAIN,
        resourceId: domainId,
        detail: { domain },
        userId,
      },
    })
  } catch (err) {
    console.error("audit log failed (domain)", err)
  }
}

async function getOwnedDomainOrThrow(userId: string, domainId: string) {
  const domain = await db.domain.findFirst({
    where: { id: domainId, ownerId: userId },
    include: {
      verifications: { orderBy: { createdAt: "desc" } },
      _count: { select: { formLinks: true } },
    },
  })
  if (!domain) throw new ApiError("Domain not found", 404)
  return domain
}

export async function getDomainCountForUser(userId: string) {
  return db.domain.count({ where: { ownerId: userId } })
}

export async function listDomainsForUser(userId: string) {
  return db.domain.findMany({
    where: { ownerId: userId },
    include: {
      verifications: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { formLinks: true } },
    },
    orderBy: { createdAt: "desc" },
  })
}

export type DomainWithVerification = Awaited<
  ReturnType<typeof listDomainsForUser>
>[number]

export async function getDomainForUser(userId: string, domainId: string) {
  return getOwnedDomainOrThrow(userId, domainId)
}

export type DomainDetail = Awaited<ReturnType<typeof getDomainForUser>>

export async function createDomainForUser(
  userId: string,
  input: CreateDomainInput
) {
  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user) throw new ApiError("Unauthorized", 401)
  if (!user.emailVerified) {
    throw new ApiError("Verify your email before registering a domain.", 403)
  }
  const domain = assertValidDomain(input.domain)
  const existing = await db.domain.findUnique({ where: { domain } })
  if (existing) {
    throw new ApiError("This domain is already registered.", 409)
  }
  const method: DomainVerificationMethod = input.method ?? "DNS_TXT"
  const created = await db.domain.create({
    data: {
      name: domain,
      domain,
      ownerId: userId,
      verifications: {
        create: {
          method,
          challenge: newChallenge(),
          expiresAt: challengeExpiresAt(),
        },
      },
    },
    include: {
      verifications: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { formLinks: true } },
    },
  })
  await logDomainAudit(userId, AuditAction.CREATE, created.id, domain)
  return created
}

// Switch the verification method. The challenge value is the SAME for
// all three methods — switching methods never issues a new one. A fresh
// challenge is only created when no pending verification exists (the old
// one expired or failed its attempts).
export async function startVerificationForUser(
  userId: string,
  domainId: string,
  input: ReverifyDomainInput
) {
  const domain = await getOwnedDomainOrThrow(userId, domainId)
  if (domain.status === DomainStatus.VERIFIED) {
    throw new ApiError("This domain is already verified.", 409)
  }
  if (domain.status === DomainStatus.SUSPENDED) {
    throw new ApiError(
      "This domain is suspended. Reactivate it before verifying.",
      409
    )
  }
  const method: DomainVerificationMethod =
    input.method ??
    domain.verifications[0]?.method ??
    DomainVerificationMethod.DNS_TXT
  const pending = domain.verifications.find(
    (v) => v.status === DomainVerificationStatus.PENDING
  )
  if (pending) {
    if (pending.method === method) return pending
    return db.domainVerification.update({
      where: { id: pending.id },
      data: { method },
    })
  }
  return db.domainVerification.create({
    data: {
      domainId,
      method,
      challenge: newChallenge(),
      expiresAt: challengeExpiresAt(),
    },
  })
}

export async function verifyDomainForUser(userId: string, domainId: string) {
  const domain = await getOwnedDomainOrThrow(userId, domainId)
  if (domain.status === DomainStatus.VERIFIED) {
    return {
      verified: true,
      domain,
      attempts: 0,
      maxAttempts: MAX_VERIFICATION_ATTEMPTS,
    }
  }
  if (domain.status === DomainStatus.SUSPENDED) {
    throw new ApiError(
      "This domain is suspended. Reactivate it before verifying.",
      409
    )
  }
  const verification = domain.verifications.find(
    (v) => v.status === DomainVerificationStatus.PENDING
  )
  if (!verification) {
    throw new ApiError(
      "No pending verification. Start a new verification first.",
      404
    )
  }
  if (verification.expiresAt && verification.expiresAt < new Date()) {
    await db.domainVerification.update({
      where: { id: verification.id },
      data: { status: DomainVerificationStatus.EXPIRED },
    })
    throw new ApiError(
      "This verification challenge expired. Start a new verification.",
      410
    )
  }
  const result = await checkVerification(
    domain.domain,
    verification.method,
    verification.challenge
  )
  if (result.ok) {
    const now = new Date()
    await db.$transaction([
      db.domainVerification.update({
        where: { id: verification.id },
        data: { status: DomainVerificationStatus.VERIFIED, verifiedAt: now },
      }),
      db.domain.update({
        where: { id: domain.id },
        data: { status: DomainStatus.VERIFIED, verifiedAt: now },
      }),
    ])
    await logDomainAudit(userId, AuditAction.VERIFY, domain.id, domain.domain)
    return {
      verified: true,
      domain: { ...domain, status: DomainStatus.VERIFIED, verifiedAt: now },
      attempts: verification.attempts,
      maxAttempts: MAX_VERIFICATION_ATTEMPTS,
    }
  }
  const attempts = verification.attempts + 1
  await db.domainVerification.update({
    where: { id: verification.id },
    data: {
      attempts,
      ...(attempts >= MAX_VERIFICATION_ATTEMPTS
        ? { status: DomainVerificationStatus.FAILED }
        : {}),
    },
  })
  return {
    verified: false,
    domain,
    attempts,
    maxAttempts: MAX_VERIFICATION_ATTEMPTS,
    reason: result.reason,
  }
}

export async function setDomainStatusForUser(
  userId: string,
  domainId: string,
  input: DomainActionInput
) {
  const domain = await getOwnedDomainOrThrow(userId, domainId)
  if (input.action === "suspend") {
    if (domain.status === DomainStatus.SUSPENDED) {
      throw new ApiError("This domain is already suspended.", 409)
    }
    const updated = await db.domain.update({
      where: { id: domain.id },
      data: { status: DomainStatus.SUSPENDED },
    })
    await logDomainAudit(userId, AuditAction.SUSPEND, domain.id, domain.domain)
    return updated
  }
  if (domain.status !== DomainStatus.SUSPENDED) {
    throw new ApiError("Only a suspended domain can be reactivated.", 409)
  }
  const updated = await db.domain.update({
    where: { id: domain.id },
    data: {
      status: domain.verifiedAt ? DomainStatus.VERIFIED : DomainStatus.PENDING,
    },
  })
  await logDomainAudit(userId, AuditAction.REACTIVATE, domain.id, domain.domain)
  return updated
}

export async function deleteDomainForUser(userId: string, domainId: string) {
  const domain = await getOwnedDomainOrThrow(userId, domainId)
  if (domain._count.formLinks > 0) {
    throw new ApiError(
      "This domain is linked to forms. Unlink it from all forms first.",
      409
    )
  }
  await db.domain.delete({ where: { id: domain.id } })
  await logDomainAudit(userId, AuditAction.DELETE, domain.id, domain.domain)
}
