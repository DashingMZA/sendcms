import { randomBytes } from "node:crypto"
import {
  AuditAction,
  AuditResource,
  DomainStatus,
  DomainVerificationMethod,
  DomainVerificationStatus,
  Prisma,
  db,
} from "@sendcms/database"

import { ApiError } from "@sendcms/shared"

import { logAudit } from "@sendcms/security"

import { checkLimitStrict } from "@sendcms/plans"

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

// SDK-021 / SEC-207: the submit preflight carries no form context, so
// the only check it can do is a global one — is the origin's host a
// VERIFIED domain at all? Non-verified origins get no CORS headers, so
// the browser blocks the request. (The POST check is stricter still:
// the origin must be a VERIFIED domain linked to that form.)
export async function isVerifiedOrigin(
  origin: string | null
): Promise<boolean> {
  if (!origin) return false
  let host: string
  try {
    host = normalizeDomain(new URL(origin).hostname)
  } catch {
    return false
  }
  if (!host) return false
  const domain = await db.domain.findFirst({
    where: { domain: host, status: DomainStatus.VERIFIED },
    select: { id: true },
  })
  return domain !== null
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

async function getOwnedDomainOrThrow(userId: string, domainId: string) {
  const domain = await db.domain.findFirst({
    where: { id: domainId, ownerId: userId },
    include: {
      // DB-046: newest 50 verifications only — every re-verification
      // appends a row, and the detail page used to load the whole
      // history. A PENDING verification is always the newest row
      // (startVerification reuses it under a lock), so the cap can
      // never hide the row verifyDomainForUser looks for.
      verifications: { orderBy: { createdAt: "desc" }, take: 50 },
      _count: { select: { formLinks: true, verifications: true } },
    },
  })
  if (!domain) throw new ApiError("Domain not found", 404)
  // `??` fallback: the count is always selected above, but a caller
  // handing in a partial row still gets a sane count, never undefined.
  const verificationCount =
    domain._count.verifications ?? domain.verifications.length
  return {
    ...domain,
    verificationCount,
    hasMoreVerifications: verificationCount > domain.verifications.length,
  }
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

// DSH-107: the paged list. `listDomainsForUser` above stays the
// unpaged call the dashboard pages and MCP tools use (they render
// every row); the API route takes this one so `?search=&page=&
// perPage=` (or `limit=` as an alias for `perPage`) is honoured
// instead of silently dropped. Pagination is clamped here, at the
// service, not only at the route (DB-049's rule).
export type DomainListQuery = {
  search?: string
  page?: number
  perPage?: number
  sortBy?: "createdAt" | "name"
  sortDir?: "asc" | "desc"
}

export type DomainListResult = {
  items: DomainWithVerification[]
  total: number
  page: number
  perPage: number
}

function domainListWhere(
  userId: string,
  query: DomainListQuery
): Prisma.DomainWhereInput {
  const where: Prisma.DomainWhereInput = { ownerId: userId }
  const search = query.search?.trim()
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { domain: { contains: search, mode: "insensitive" } },
    ]
  }
  return where
}

export async function listDomainsPageForUser(
  userId: string,
  query: DomainListQuery = {}
): Promise<DomainListResult> {
  const page = Number.isFinite(query.page)
    ? Math.max(1, Math.floor(query.page as number))
    : 1
  const perPage = Number.isFinite(query.perPage)
    ? Math.min(100, Math.max(1, Math.floor(query.perPage as number)))
    : 20
  const where = domainListWhere(userId, query)
  const orderBy =
    query.sortBy === "name"
      ? { name: query.sortDir ?? "asc" }
      : { createdAt: query.sortDir ?? "desc" }
  const [total, items] = await Promise.all([
    db.domain.count({ where }),
    db.domain.findMany({
      where,
      include: {
        verifications: { orderBy: { createdAt: "desc" }, take: 1 },
        _count: { select: { formLinks: true } },
      },
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ])
  return { items, total, page, perPage }
}

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
  const method: DomainVerificationMethod = input.method ?? "DNS_TXT"
  // DB-029: the plan quota check and the create run under a
  // per-user advisory lock, so two concurrent creates cannot both
  // see `used = limit - 1` and both succeed. The lock is
  // transaction-scoped (same pattern as submitForm's submit locks)
  // and serializes this user's domain creates; the P2002 catch
  // below still covers a same-hostname race from another user.
  let created
  try {
    created = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"sendcms:create:domain:" + userId}))`
      // Entitlement guard (Phase 4): the DOMAINS limit from the user's
      // effective plan. SRC-216: fail CLOSED — a plans-module error
      // refuses the creation (503) instead of silently granting
      // unlimited domains.
      const limit = await checkLimitStrict(userId, "DOMAINS")
      if (!limit.allowed) {
        throw new ApiError(
          `Your plan allows at most ${limit.limit} domains. Upgrade your plan or ask an admin to raise your limit.`,
          409
        )
      }
      const existing = await tx.domain.findUnique({ where: { domain } })
      if (existing) {
        throw new ApiError("This domain is already registered.", 409)
      }
      return tx.domain.create({
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
    })
  } catch (err) {
    // SRC-206: the pre-check is not enough — a concurrent duplicate
    // surfaces as P2002, which is a 409, never a generic 500.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ApiError("This domain is already registered.", 409)
    }
    throw err
  }
  await logAudit({
    userId,
    action: AuditAction.CREATE,
    resourceType: AuditResource.DOMAIN,
    resourceId: created.id,
    detail: { domain: domain },
  })
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
  // DB-030: the pending check and the create run under a per-domain
  // advisory lock, re-reading the pending row inside the transaction
  // — two concurrent starts that both loaded "no pending
  // verification" can no longer both create a PENDING row (the
  // second would orphan a challenge nothing ever checks).
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"sendcms:verify:" + domainId}))`
    const pending = await tx.domainVerification.findFirst({
      where: { domainId, status: DomainVerificationStatus.PENDING },
      orderBy: { createdAt: "desc" },
    })
    if (pending) {
      if (pending.method === method) return pending
      return tx.domainVerification.update({
        where: { id: pending.id },
        data: { method },
      })
    }
    return tx.domainVerification.create({
      data: {
        domainId,
        method,
        challenge: newChallenge(),
        expiresAt: challengeExpiresAt(),
      },
    })
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
    await logAudit({
      userId,
      action: AuditAction.VERIFY,
      resourceType: AuditResource.DOMAIN,
      resourceId: domain.id,
      detail: { domain: domain.domain },
    })
    return {
      verified: true,
      domain: withPatchedVerification(
        { ...domain, status: DomainStatus.VERIFIED, verifiedAt: now },
        verification.id,
        {
          status: DomainVerificationStatus.VERIFIED,
          verifiedAt: now,
        }
      ),
      attempts: verification.attempts,
      maxAttempts: MAX_VERIFICATION_ATTEMPTS,
    }
  }
  // DB-030: the attempt counter is an atomic increment, not a
  // read-then-write — two concurrent failures used to both read N
  // and both write N+1, so the counter undercounted and a challenge
  // could absorb more than MAX attempts. The increment's return
  // value is the post-increment count; the FAILED flip is a
  // conditional updateMany so concurrent flippers cannot race it.
  const updatedVerification = await db.domainVerification.update({
    where: { id: verification.id },
    data: { attempts: { increment: 1 } },
  })
  const attempts = updatedVerification.attempts
  // DB-030: the annotation matters — without it TS narrows the
  // initializer to the "PENDING" literal and the FAILED assignment
  // below fails typecheck (TS2322).
  let verificationStatus: DomainVerificationStatus =
    DomainVerificationStatus.PENDING
  if (attempts >= MAX_VERIFICATION_ATTEMPTS) {
    await db.domainVerification.updateMany({
      where: {
        id: verification.id,
        status: DomainVerificationStatus.PENDING,
      },
      data: { status: DomainVerificationStatus.FAILED },
    })
    verificationStatus = DomainVerificationStatus.FAILED
  }
  return {
    verified: false,
    domain: withPatchedVerification(domain, verification.id, {
      attempts,
      status: verificationStatus,
    }),
    attempts,
    maxAttempts: MAX_VERIFICATION_ATTEMPTS,
    reason: result.reason,
  }
}

// DSH-106: the domain row is loaded BEFORE the attempt, so returning
// it verbatim leaves the nested verification stale (its `attempts`
// is the pre-update count, its `status` still PENDING once the
// challenge FAILED or VERIFIED) next to the top-level `attempts`.
// Patch the nested row to the post-update values so the payload is
// self-consistent — the dashboard reads `verification.attempts` from
// the nested object.
function withPatchedVerification(
  domain: DomainDetail,
  verificationId: string,
  patch: {
    status?: DomainVerificationStatus
    verifiedAt?: Date
    attempts?: number
  }
): DomainDetail {
  return {
    ...domain,
    verifications: domain.verifications.map((v) =>
      v.id === verificationId ? { ...v, ...patch } : v
    ),
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
    await logAudit({
      userId,
      action: AuditAction.SUSPEND,
      resourceType: AuditResource.DOMAIN,
      resourceId: domain.id,
      detail: { domain: domain.domain },
    })
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
  await logAudit({
    userId,
    action: AuditAction.REACTIVATE,
    resourceType: AuditResource.DOMAIN,
    resourceId: domain.id,
    detail: { domain: domain.domain },
  })
  return updated
}

/** Deletes a domain (Phase 16, SRC-208): the caller must pass the
    domain string as an explicit confirmation token, so a stray click
    or a replayed request cannot delete a domain the owner did not
    name. The delete itself stays physical: it is refused while any
    form is linked, so nothing cascades (the FormDomain links are the
    only dependents, and the guard above already requires zero). */
export async function deleteDomainForUser(
  userId: string,
  domainId: string,
  confirmation: string
) {
  const domain = await getOwnedDomainOrThrow(userId, domainId)
  if (confirmation !== domain.domain) {
    throw new ApiError("Confirmation does not match the domain name.", 422)
  }
  if (domain._count.formLinks > 0) {
    throw new ApiError(
      "This domain is linked to forms. Unlink it from all forms first.",
      409
    )
  }
  await db.domain.delete({ where: { id: domain.id } })
  await logAudit({
    userId,
    action: AuditAction.DELETE,
    resourceType: AuditResource.DOMAIN,
    resourceId: domain.id,
    detail: { domain: domain.domain },
  })
}
