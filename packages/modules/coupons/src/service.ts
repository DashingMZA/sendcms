import type { AdminSession } from "@sendcms/auth"
import { AuditAction, AuditResource, Prisma, db } from "@sendcms/database"
import { requireAdmin } from "@sendcms/permissions"
import { logAudit } from "@sendcms/security"
import { ApiError } from "@sendcms/shared"
import {
  CreateCouponSchema,
  UpdateCouponSchema,
  type CreateCouponInput,
  type CreateCouponParsed,
  type UpdateCouponInput,
  type UpdateCouponParsed,
} from "./validators"

// Platform discount codes (Seven Admin Pages, Phase D, plan §3.7,
// Q6/Q7/Q10). Framework-independent (no Next.js imports); only
// services import @sendcms/database. Authorization lives HERE, not
// in the routes: admin functions take the actor's AdminSession first
// and enforce their capability (VIEW_BILLING reads, MANAGE_BILLING
// writes — Q10: MANAGER may NOT create coupons, owner + SUPER_ADMIN
// only). No step-up for create/disable/delete (reversible / soft).
//
// Q6 semantics: both PERCENT + FIXED; optional per-code + per-user
// caps (null = unlimited); optional expiry; optional plan scoping
// (empty = all plans); firstPurchaseOnly flag; NO stacking in v1
// (one code per checkout). Q7: platform-only codes — no
// provider-native sync in v1.
//
// `redemptionCount` is a derived cache, rebuildable from
// CouponRedemption — it is never set directly outside
// recordRedemption, which increments it atomically with the
// redemption insert (conditional updateMany, Wave 1 pattern).

export type CouponDiscountType = "PERCENT" | "FIXED"
export type CouponStatus = "ACTIVE" | "DISABLED" | "EXPIRED"

export interface CouponSummary {
  id: string
  code: string
  name: string | null
  description: string | null
  discountType: CouponDiscountType
  discountValue: number
  currency: string
  maxRedemptions: number | null
  redemptionCount: number
  maxRedemptionsPerUser: number | null
  validFrom: Date | null
  validUntil: Date | null
  appliesToPlanIds: string[]
  appliesToBillingInterval: string | null
  firstPurchaseOnly: boolean
  status: CouponStatus
  createdById: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CouponRedemptionRow {
  id: string
  couponId: string
  userId: string
  userName: string | null
  userEmail: string | null
  subscriptionId: string | null
  checkoutAttemptId: string | null
  discountAmount: number
  currency: string
  createdAt: Date
}

export interface CouponValidation {
  coupon: CouponSummary
  discountAmountMinor: number
  finalAmountMinor: number
  currency: string
}

type CouponRow = {
  id: string
  code: string
  name: string | null
  description: string | null
  discountType: CouponDiscountType
  discountValue: number
  currency: string
  maxRedemptions: number | null
  redemptionCount: number
  maxRedemptionsPerUser: number | null
  validFrom: Date | null
  validUntil: Date | null
  appliesToPlanIds: string[]
  appliesToBillingInterval: string | null
  firstPurchaseOnly: boolean
  status: CouponStatus
  createdById: string | null
  createdAt: Date
  updatedAt: Date
}

function toCouponSummary(row: CouponRow): CouponSummary {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    discountType: row.discountType,
    discountValue: row.discountValue,
    currency: row.currency,
    maxRedemptions: row.maxRedemptions,
    redemptionCount: row.redemptionCount,
    maxRedemptionsPerUser: row.maxRedemptionsPerUser,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    appliesToPlanIds: row.appliesToPlanIds,
    appliesToBillingInterval: row.appliesToBillingInterval,
    firstPurchaseOnly: row.firstPurchaseOnly,
    status: row.status,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase()
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  )
}

// EXPIRED is derived, not maintained by a background job: a coupon
// is expired when its validUntil has passed or a set redemption cap
// has been reached. Prisma cannot express the column-to-column
// comparison (redemptionCount >= maxRedemptions) in a where clause,
// so the "Expired" list filter fetches the candidate set (past
// validUntil OR a cap set) and applies this predicate in memory —
// the candidate set is the admin-managed coupon table, not a
// customer-scale table, so the in-memory pass stays small.
function isExpired(
  coupon: Pick<CouponRow, "validUntil" | "maxRedemptions" | "redemptionCount">,
  now: Date
): boolean {
  if (coupon.validUntil && coupon.validUntil < now) return true
  return (
    coupon.maxRedemptions !== null &&
    coupon.redemptionCount >= coupon.maxRedemptions
  )
}

function couponSearchWhere(search: string): Prisma.CouponWhereInput {
  return {
    OR: [
      { code: { contains: search, mode: "insensitive" } },
      { name: { contains: search, mode: "insensitive" } },
    ],
  }
}

function totalPagesFor(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(total / perPage))
}

// ─── Checkout validation ────────────────────────────────────────────────

// Validates a code for one checkout. Throws ApiError 422 with a
// clear, customer-safe message when invalid; never leaks internals.
// Rules, in order: normalise → exists → ACTIVE → in the
// [validFrom, validUntil] window → under the redemption cap → under
// the per-user cap → plan eligible + billing interval matches →
// firstPurchaseOnly. PERCENT: discount = floor(price * value / 100),
// capped at the price. FIXED: discount = min(value, price). FIXED
// uses the coupon currency (mismatch with the price currency →
// 422); PERCENT uses the price currency.
export async function validateCouponForCheckout(input: {
  code: string
  userId: string
  planVersionId: string
  priceAmountMinor: number
  currency: string
}): Promise<CouponValidation> {
  const code = normalizeCode(input.code)
  if (!code || /\s/.test(code)) {
    throw new ApiError("This coupon code is not valid.", 422)
  }
  const coupon = await db.coupon.findUnique({ where: { code } })
  if (!coupon) {
    throw new ApiError("This coupon code is not valid.", 422)
  }
  if (coupon.status !== "ACTIVE") {
    throw new ApiError("This coupon is no longer active.", 422)
  }
  const now = new Date()
  if (coupon.validFrom && now < coupon.validFrom) {
    throw new ApiError("This coupon is not valid yet.", 422)
  }
  if (coupon.validUntil && now > coupon.validUntil) {
    throw new ApiError("This coupon has expired.", 422)
  }
  if (
    coupon.maxRedemptions !== null &&
    coupon.redemptionCount >= coupon.maxRedemptions
  ) {
    throw new ApiError("This coupon has reached its redemption limit.", 422)
  }
  if (coupon.maxRedemptionsPerUser !== null) {
    const usedByUser = await db.couponRedemption.count({
      where: { couponId: coupon.id, userId: input.userId },
    })
    if (usedByUser >= coupon.maxRedemptionsPerUser) {
      throw new ApiError(
        "You have already used this coupon the maximum number of times.",
        422
      )
    }
  }
  const version = await db.planVersion.findUnique({
    where: { id: input.planVersionId },
    select: { planId: true, billingInterval: true },
  })
  if (!version) throw new ApiError("Plan version not found", 404)
  if (
    coupon.appliesToPlanIds.length > 0 &&
    !coupon.appliesToPlanIds.includes(version.planId)
  ) {
    throw new ApiError("This coupon does not apply to this plan.", 422)
  }
  if (
    coupon.appliesToBillingInterval !== null &&
    coupon.appliesToBillingInterval !== version.billingInterval
  ) {
    throw new ApiError(
      "This coupon does not apply to this billing interval.",
      422
    )
  }
  if (coupon.firstPurchaseOnly) {
    const [liveSubscription, priorPurchase] = await Promise.all([
      db.subscription.findFirst({
        where: {
          userId: input.userId,
          status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
        },
        select: { id: true },
      }),
      db.oneTimePurchase.findFirst({
        where: { userId: input.userId },
        select: { id: true },
      }),
    ])
    if (liveSubscription || priorPurchase) {
      throw new ApiError(
        "This coupon is only valid for your first purchase.",
        422
      )
    }
  }
  if (
    coupon.discountType === "FIXED" &&
    coupon.currency.toUpperCase() !== input.currency.toUpperCase()
  ) {
    throw new ApiError("This coupon is not valid for this currency.", 422)
  }
  const price = input.priceAmountMinor
  const discount =
    coupon.discountType === "PERCENT"
      ? Math.min(Math.floor((price * coupon.discountValue) / 100), price)
      : Math.min(coupon.discountValue, price)
  return {
    coupon: toCouponSummary(coupon),
    discountAmountMinor: discount,
    finalAmountMinor: price - discount,
    currency:
      coupon.discountType === "FIXED" ? coupon.currency : input.currency,
  }
}

// ─── Redemption (called by the grant path, inside its transaction) ──────

// Read-only lookup by code inside a transaction — NO business
// rules, no caps, no expiry checks. The grant path uses it to
// resolve the attempt's coupon id without re-running validation:
// a code expiring (or hitting its cap) between checkout and grant
// must not refuse a paid grant — the discount was validated and
// locked in at checkout time, and the attempt stores the agreed
// discount amount. Returns null when the code no longer exists
// (deleted after checkout); the grant still proceeds.
export async function getCouponByCode(
  tx: Prisma.TransactionClient,
  code: string
): Promise<CouponSummary | null> {
  const row = await tx.coupon.findUnique({
    where: { code: normalizeCode(code) },
  })
  return row ? toCouponSummary(row as CouponRow) : null
}

// Inserts the CouponRedemption row AND atomically increments
// Coupon.redemptionCount via a conditional updateMany
// (redemptionCount < maxRedemptions, or unconditional when
// maxRedemptions is null — the Wave 1 pattern). Throws ApiError 409
// when the cap was reached between validation and grant; the caller
// aborts its transaction on this throw, so the redemption row rolls
// back with it. The refusal is audit-logged (outside the caller's
// transaction — the failure itself is the record).
export async function recordRedemption(
  tx: Prisma.TransactionClient,
  input: {
    couponId: string
    userId: string
    subscriptionId?: string | null
    checkoutAttemptId?: string | null
    discountAmountMinor: number
    currency: string
  }
): Promise<void> {
  const coupon = await tx.coupon.findUnique({
    where: { id: input.couponId },
    select: { id: true, maxRedemptions: true },
  })
  if (!coupon) throw new ApiError("Coupon not found", 404)
  await tx.couponRedemption.create({
    data: {
      couponId: input.couponId,
      userId: input.userId,
      subscriptionId: input.subscriptionId ?? null,
      checkoutAttemptId: input.checkoutAttemptId ?? null,
      discountAmount: input.discountAmountMinor,
      currency: input.currency,
    },
  })
  const updated = await tx.coupon.updateMany({
    where:
      coupon.maxRedemptions === null
        ? { id: input.couponId }
        : {
            id: input.couponId,
            redemptionCount: { lt: coupon.maxRedemptions },
          },
    data: { redemptionCount: { increment: 1 } },
  })
  if (updated.count === 0) {
    await logAudit({
      userId: input.userId,
      action: AuditAction.UPDATE,
      resourceType: AuditResource.COUPON,
      resourceId: input.couponId,
      detail: {
        event: "coupon-redemption-rejected",
        reason: "redemption-cap-reached",
      },
    })
    throw new ApiError("This coupon has reached its redemption limit.", 409)
  }
}

// ─── Admin: list / get ──────────────────────────────────────────────────

export async function listCoupons(
  actor: AdminSession,
  filters: {
    page?: number
    perPage?: number
    status?: CouponStatus | "all"
    search?: string
  }
): Promise<{
  coupons: CouponSummary[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "VIEW_BILLING")
  const page = filters.page ?? 1
  const perPage = filters.perPage ?? 20
  const status = filters.status ?? "all"
  const search = filters.search?.trim() || undefined
  const now = new Date()
  const searchWhere = search ? couponSearchWhere(search) : undefined

  if (status === "EXPIRED") {
    // See isExpired: the cap half of "expired" cannot be expressed
    // in a Prisma where, so the candidate set is fetched and the
    // exact predicate applied in memory before pagination.
    const candidates = await db.coupon.findMany({
      where: {
        AND: [
          ...(searchWhere ? [searchWhere] : []),
          {
            OR: [
              { validUntil: { lt: now } },
              { maxRedemptions: { not: null } },
            ],
          },
        ],
      },
      orderBy: { createdAt: "desc" },
    })
    const expired = candidates.filter((row) => isExpired(row, now))
    return {
      coupons: expired
        .slice((page - 1) * perPage, page * perPage)
        .map(toCouponSummary),
      total: expired.length,
      page,
      perPage,
      totalPages: totalPagesFor(expired.length, perPage),
    }
  }

  if (status === "ACTIVE") {
    // Live-found (Phase D consolidation): a stored-ACTIVE code
    // whose window has passed (or whose cap was reached) is
    // expired, not active — the old stored-status-only filter
    // listed it under Active AND under Expired. The Active tab
    // shows only usable codes. Same in-memory pattern as EXPIRED
    // (see isExpired): the candidate set is the admin coupon
    // table, not a customer-scale table.
    const candidates = await db.coupon.findMany({
      where: {
        AND: [{ status: "ACTIVE" }, ...(searchWhere ? [searchWhere] : [])],
      },
      orderBy: { createdAt: "desc" },
    })
    const active = candidates.filter((row) => !isExpired(row, now))
    return {
      coupons: active
        .slice((page - 1) * perPage, page * perPage)
        .map(toCouponSummary),
      total: active.length,
      page,
      perPage,
      totalPages: totalPagesFor(active.length, perPage),
    }
  }

  const where: Prisma.CouponWhereInput = {
    ...(status !== "all" ? { status } : {}),
    ...(searchWhere ? searchWhere : {}),
  }
  const [total, rows] = await Promise.all([
    db.coupon.count({ where }),
    db.coupon.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ])
  return {
    coupons: rows.map(toCouponSummary),
    total,
    page,
    perPage,
    totalPages: totalPagesFor(total, perPage),
  }
}

export async function getCoupon(
  actor: AdminSession,
  id: string
): Promise<CouponSummary> {
  requireAdmin(actor, "VIEW_BILLING")
  const coupon = await db.coupon.findUnique({ where: { id } })
  if (!coupon) throw new ApiError("Coupon not found", 404)
  return toCouponSummary(coupon)
}

// ─── Admin: create / disable / delete (soft) ───────────────────────────

export async function createCoupon(
  actor: AdminSession,
  input: CreateCouponInput
): Promise<CouponSummary> {
  requireAdmin(actor, "MANAGE_BILLING")
  let parsed: CreateCouponParsed
  try {
    parsed = CreateCouponSchema.parse(input)
  } catch (err) {
    if (err instanceof Error && err.name === "ZodError") {
      const first = (err as { issues?: { message?: string }[] }).issues?.[0]
        ?.message
      throw new ApiError(first ?? "Invalid coupon.", 422)
    }
    throw err
  }
  const code = normalizeCode(parsed.code)
  if (/\s/.test(code)) {
    throw new ApiError("Coupon code must not contain spaces.", 422)
  }
  const existing = await db.coupon.findUnique({ where: { code } })
  if (existing) {
    throw new ApiError("A coupon with this code already exists.", 409)
  }
  let created: CouponRow
  try {
    created = await db.coupon.create({
      data: {
        code,
        name: parsed.name ?? null,
        description: parsed.description ?? null,
        discountType: parsed.discountType,
        discountValue: parsed.discountValue,
        currency: parsed.currency,
        maxRedemptions: parsed.maxRedemptions ?? null,
        maxRedemptionsPerUser: parsed.maxRedemptionsPerUser ?? null,
        validFrom: parsed.validFrom ?? null,
        validUntil: parsed.validUntil ?? null,
        appliesToPlanIds: parsed.appliesToPlanIds,
        appliesToBillingInterval: parsed.appliesToBillingInterval ?? null,
        firstPurchaseOnly: parsed.firstPurchaseOnly,
        status: "ACTIVE",
        createdById: actor.user.id,
      },
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError("A coupon with this code already exists.", 409)
    }
    throw err
  }
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.CREATE,
    resourceType: AuditResource.COUPON,
    resourceId: created.id,
    detail: {
      event: "coupon-created",
      code: created.code,
      discountType: created.discountType,
      discountValue: created.discountValue,
    },
  })
  return toCouponSummary(created)
}

export async function disableCoupon(
  actor: AdminSession,
  id: string
): Promise<CouponSummary> {
  requireAdmin(actor, "MANAGE_BILLING")
  const coupon = await db.coupon.findUnique({ where: { id } })
  if (!coupon) throw new ApiError("Coupon not found", 404)
  const updated = await db.coupon.update({
    where: { id },
    data: { status: "DISABLED" },
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.COUPON,
    resourceId: id,
    detail: { event: "coupon-disabled", code: coupon.code },
  })
  return toCouponSummary(updated)
}

// Field edits + re-enable (PATCH). The deal itself (code,
// discountType, discountValue, currency) is NOT mutable —
// UpdateCouponSchema rejects those keys. A cap may not drop
// below the redemptions already recorded, and the merged
// [validFrom, validUntil] window must stay valid when only one
// end moves. Fields sent as null are cleared; omitted fields are
// left alone.
export async function updateCoupon(
  actor: AdminSession,
  id: string,
  input: UpdateCouponInput
): Promise<CouponSummary> {
  requireAdmin(actor, "MANAGE_BILLING")
  let parsed: UpdateCouponParsed
  try {
    parsed = UpdateCouponSchema.parse(input)
  } catch (err) {
    if (err instanceof Error && err.name === "ZodError") {
      const first = (err as { issues?: { message?: string }[] }).issues?.[0]
        ?.message
      throw new ApiError(first ?? "Invalid coupon update.", 422)
    }
    throw err
  }
  const coupon = await db.coupon.findUnique({ where: { id } })
  if (!coupon) throw new ApiError("Coupon not found", 404)
  if (
    parsed.maxRedemptions !== undefined &&
    parsed.maxRedemptions !== null &&
    parsed.maxRedemptions < coupon.redemptionCount
  ) {
    throw new ApiError(
      "maxRedemptions cannot be below the redemptions already recorded.",
      422
    )
  }
  const effectiveFrom =
    parsed.validFrom === undefined ? coupon.validFrom : parsed.validFrom
  const effectiveUntil =
    parsed.validUntil === undefined ? coupon.validUntil : parsed.validUntil
  if (effectiveFrom && effectiveUntil && effectiveUntil <= effectiveFrom) {
    throw new ApiError("validUntil must be after validFrom.", 422)
  }
  const updated = await db.coupon.update({
    where: { id },
    data: {
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.description !== undefined
        ? { description: parsed.description }
        : {}),
      ...(parsed.maxRedemptions !== undefined
        ? { maxRedemptions: parsed.maxRedemptions }
        : {}),
      ...(parsed.maxRedemptionsPerUser !== undefined
        ? { maxRedemptionsPerUser: parsed.maxRedemptionsPerUser }
        : {}),
      ...(parsed.validFrom !== undefined
        ? { validFrom: parsed.validFrom }
        : {}),
      ...(parsed.validUntil !== undefined
        ? { validUntil: parsed.validUntil }
        : {}),
      ...(parsed.appliesToPlanIds !== undefined
        ? { appliesToPlanIds: parsed.appliesToPlanIds }
        : {}),
      ...(parsed.appliesToBillingInterval !== undefined
        ? { appliesToBillingInterval: parsed.appliesToBillingInterval }
        : {}),
      ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    },
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.COUPON,
    resourceId: id,
    detail: { event: "coupon-updated", code: coupon.code },
  })
  return toCouponSummary(updated)
}

// SOFT ONLY: status → DISABLED, never a physical delete; redemption
// history is untouched (redemptions stay, code shows DISABLED).
export async function deleteCoupon(
  actor: AdminSession,
  id: string
): Promise<CouponSummary> {
  requireAdmin(actor, "MANAGE_BILLING")
  const coupon = await db.coupon.findUnique({ where: { id } })
  if (!coupon) throw new ApiError("Coupon not found", 404)
  const updated = await db.coupon.update({
    where: { id },
    data: { status: "DISABLED" },
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.DELETE,
    resourceType: AuditResource.COUPON,
    resourceId: id,
    detail: {
      event: "coupon-deleted",
      code: coupon.code,
      soft: true,
    },
  })
  return toCouponSummary(updated)
}

// ─── Admin: redemptions ─────────────────────────────────────────────────

export async function listCouponRedemptions(
  actor: AdminSession,
  couponId: string,
  filters?: { page?: number; perPage?: number }
): Promise<{
  redemptions: CouponRedemptionRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "VIEW_BILLING")
  const page = filters?.page ?? 1
  const perPage = filters?.perPage ?? 20
  const coupon = await db.coupon.findUnique({ where: { id: couponId } })
  if (!coupon) throw new ApiError("Coupon not found", 404)
  const [total, rows] = await Promise.all([
    db.couponRedemption.count({ where: { couponId } }),
    db.couponRedemption.findMany({
      where: { couponId },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ])
  return {
    redemptions: rows.map((row) => ({
      id: row.id,
      couponId: row.couponId,
      userId: row.userId,
      userName: row.user.name,
      userEmail: row.user.email,
      subscriptionId: row.subscriptionId,
      checkoutAttemptId: row.checkoutAttemptId,
      discountAmount: row.discountAmount,
      currency: row.currency,
      createdAt: row.createdAt,
    })),
    total,
    page,
    perPage,
    totalPages: totalPagesFor(total, perPage),
  }
}
