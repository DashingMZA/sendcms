// Payments (Seven Admin Pages, Phase B, plan §3.5) — the money view.
//
// There is no Payment / Transaction / Charge / Refund model: payment
// data is scattered, so this module JOINS the four sources that do
// exist — BillingEvent (the webhook-event ledger), CheckoutAttempt
// (the checkout-creation support record), OneTimePurchase (the
// refund-matchable one-time money record) and PlanVersion (the price
// behind a subscription). Amounts come from the join; BillingEvent
// itself stores no amount, currency, transaction id, or invoice id.
//
// Row sources, in order — nothing is ever dropped:
// - Every BillingEvent whose normalized kind is a payment kind
//   (CHECKOUT_COMPLETED / PAYMENT_SUCCEEDED / PAYMENT_FAILED /
//   PAYMENT_REFUNDED / UNMAPPED_PAYMENT) is one row. Unmatched
//   provider events (kind UNMAPPED_PAYMENT) appear with amount
//   "unknown" (amountMinor null) and a link to the raw event — never
//   hidden. Rows whose kind is null (written before the normalized
//   kind column existed, DB-015) cannot be classified as payments
//   without parsing raw provider event-type strings, which this
//   service does not do; they stay visible on /admin/billing, which
//   does not filter by kind.
// - Every OneTimePurchase with NO covering BillingEvent is one
//   standalone row (kind ONE_TIME_PURCHASE). A purchase is covered
//   when a payment-kind event exists for the same provider + user
//   within ±24h — the webhook path always writes the event row first
//   and the purchase seconds later, so a covered purchase is the
//   same payment as its event, not a second one. Purchases created
//   by reconcileCheckout have no event row at all (that path calls
//   activateSubscriptionFromCheckout directly), so without the
//   standalone rows those paid purchases would be invisible.
// - CheckoutAttempt rows are NOT rows: COMPLETED means "the provider
//   returned a checkout URL", not "paid". Attempts are amount
//   sources (and sourceRefs) for event rows.
//
// Amount resolution for an event row, in order (first hit wins):
// 1. EXACT — a SubscriptionEvent with providerEventId equal to the
//    event's providerEventId (renewals store it, DB-010) gives the
//    subscription, whose PlanVersion price is the amount.
// 2. The closest OneTimePurchase for the same provider + user
//    within ±1h of the event (the purchase is written seconds after
//    its checkout-completed event).
// 3. The closest COMPLETED CheckoutAttempt for the same provider +
//    user created within 24h before the event (checkout creation
//    precedes payment; a customer can leave a checkout open for
//    hours, so the window is a day, not minutes).
// 4. The latest Subscription for the same provider + user — a
//    renewal/failure/refund belongs to that subscription, and its
//    PlanVersion price is the amount the provider charged.
// 5. Unknown (amountMinor null, currency null).
// Steps 2–4 are time-window heuristics, not foreign keys: the
// webhook ledger never stored the checkout or subscription id on the
// event row. The resolution is honest about that — an unmatched
// amount renders as "unknown", never as a guessed number.
//
// Pagination: the event slice and the standalone-purchase slice are
// each paginated from the database on the same page/perPage, then
// merged, sorted by `at` desc, and truncated to perPage. In the
// normal case (every purchase covered by its event) the standalone
// slice is empty and pagination is exactly the event list. When
// standalone purchases exist, a page boundary is approximate: a
// standalone purchase that sorts into a full event page is pushed to
// the next page instead of displacing an event row. `total` is exact
// (event total + standalone total).
//
// Refunds: `refundPayment` wires the EXISTING applyRefund in
// @sendcms/plans and changes nothing about its behavior. applyRefund
// is LOCAL-ONLY bookkeeping — it cancels/flips the SendCMS rows and
// writes the timeline event + audit row, but it makes NO provider
// refund call (no provider refund API exists anywhere in the
// codebase). The admin issues the refund at the provider first, then
// records it here; the refund dialog says so. The refund itself is
// step-up gated (Q11): requireStepUp runs last, after every cheap
// guard, immediately before applyRefund — the admin-users disable
// pattern — and consumes one unbound (legacy admin) verification,
// so one password entry authorizes exactly one refund.
import type { AdminSession } from "@sendcms/auth"
import {
  AuditAction,
  AuditResource,
  db,
  type BillingEventKind,
  type BillingProvider,
  type OneTimePurchaseStatus,
} from "@sendcms/database"
import { ApiError } from "@sendcms/shared"
import { logAudit, requireStepUp } from "@sendcms/security"
import { applyRefund, type SubscriptionSummary } from "@sendcms/plans"
import { requireBillingAdmin } from "./service"
import type { PaymentsQuery, RefundPaymentInput } from "./validators"

// Payment-kind BillingEvents — the closed set this list is built
// from (BillingEventKind; SUBSCRIPTION_CANCELED /
// SUBSCRIPTION_UPDATED / IGNORED are not payments and stay on
// /admin/billing).
export const PAYMENT_EVENT_KINDS = [
  "CHECKOUT_COMPLETED",
  "PAYMENT_SUCCEEDED",
  "PAYMENT_FAILED",
  "PAYMENT_REFUNDED",
  "UNMAPPED_PAYMENT",
] as const

const PAYMENT_KINDS: BillingEventKind[] = [...PAYMENT_EVENT_KINDS]

// Time windows for the amount join (see the header comment).
const AMOUNT_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000
const PURCHASE_MATCH_BEFORE_MS = 60 * 60 * 1000
const PURCHASE_MATCH_AFTER_MS = 60 * 60 * 1000

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export type PaymentTab = "all" | "succeeded" | "failed" | "refunded"

export type PaymentStatus = "SUCCEEDED" | "FAILED" | "REFUNDED" | "UNKNOWN"

// The kinds a payment row can actually have: the five payment
// BillingEventKinds plus the standalone-purchase kind. Narrower than
// BillingEventKind on purpose — SUBSCRIPTION_CANCELED /
// SUBSCRIPTION_UPDATED / IGNORED are never payment rows, and a
// Record over this union is exhaustively checkable by callers.
export type PaymentEventKind = (typeof PAYMENT_EVENT_KINDS)[number]

export type PaymentKind = PaymentEventKind | "ONE_TIME_PURCHASE"

function isPaymentEventKind(kind: BillingEventKind): kind is PaymentEventKind {
  return (PAYMENT_KINDS as readonly string[]).includes(kind)
}

export type PaymentUser = {
  id: string
  name: string | null
  email: string | null
}

export type PaymentRow = {
  id: string
  source: "billing-event" | "one-time-purchase"
  at: Date
  userId: string | null
  user: PaymentUser | null
  provider: BillingProvider
  kind: PaymentKind
  // Raw provider event type for event rows; null for purchase rows.
  eventType: string | null
  // Minor units; null = unknown (unmatched provider event).
  amountMinor: number | null
  currency: string | null
  // Payments display fix: the discount on this payment and what the
  // user actually paid, next to the undiscounted price. All three
  // are null when no discount applies (or the amount is unknown) —
  // the UI then renders amountMinor exactly as before.
  discountAmountMinor: number | null
  paidAmountMinor: number | null
  fullAmountMinor: number | null
  status: PaymentStatus
  subscriptionId: string | null
  sourceRefs: {
    billingEventId: string | null
    providerEventId: string | null
    checkoutAttemptId: string | null
    providerCheckoutId: string | null
    providerReference: string | null
    oneTimePurchaseId: string | null
  }
}

export type PaymentsPage = {
  payments: PaymentRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export type PaymentStatsBucket = {
  count: number
  // Minor units summed over the majority-currency known rows only;
  // 0 when no row has a known amount.
  amountMinor: number
  // Currency the amount is summed in; null when no row has one.
  currency: string | null
  unknownCount: number
}

export type PaymentStats = {
  paid30d: PaymentStatsBucket
  failed30d: PaymentStatsBucket
  refunded30d: PaymentStatsBucket
}

export type PaymentDetail = {
  payment: PaymentRow
  event: {
    id: string
    provider: BillingProvider
    providerEventId: string
    eventType: string
    kind: BillingEventKind
    processedAt: Date | null
    createdAt: Date
  } | null
  purchase: {
    id: string
    providerReference: string
    checkoutId: string | null
    priceAmount: number | null
    priceCurrency: string
    status: OneTimePurchaseStatus
    accessStart: Date
    accessEnd: Date
  } | null
  subscription: {
    id: string
    status: string
    planName: string | null
    planVersionId: string
    providerSubscriptionId: string | null
    currentPeriodEnd: Date | null
  } | null
}

export type PaymentRefundResult = {
  payment: PaymentDetail
  subscription: SubscriptionSummary | null
}

function kindsForTab(tab: PaymentTab): BillingEventKind[] {
  switch (tab) {
    case "succeeded":
      return ["CHECKOUT_COMPLETED", "PAYMENT_SUCCEEDED", "UNMAPPED_PAYMENT"]
    case "failed":
      return ["PAYMENT_FAILED"]
    case "refunded":
      return ["PAYMENT_REFUNDED"]
    case "all":
    default:
      return PAYMENT_KINDS
  }
}

function purchaseStatusesForTab(tab: PaymentTab): OneTimePurchaseStatus[] {
  switch (tab) {
    case "succeeded":
      return ["ACTIVE", "EXPIRED"]
    case "failed":
      return []
    case "refunded":
      return ["REFUNDED"]
    case "all":
    default:
      return ["ACTIVE", "REFUNDED", "EXPIRED"]
  }
}

function statusForEventKind(kind: BillingEventKind): PaymentStatus {
  switch (kind) {
    case "PAYMENT_FAILED":
      return "FAILED"
    case "PAYMENT_REFUNDED":
      return "REFUNDED"
    case "CHECKOUT_COMPLETED":
    case "PAYMENT_SUCCEEDED":
    case "UNMAPPED_PAYMENT":
      // UNMAPPED_PAYMENT is a PAID event that could not be applied
      // (BIL-100) — the payment happened, the mapping did not.
      return "SUCCEEDED"
    default:
      return "UNKNOWN"
  }
}

// ─── Refund linkage (F2, Wave 11) ─────────────────────────────────────

// `applyRefund` writes NO `PAYMENT_REFUNDED` BillingEvent, so a tab
// that matches on the event kind alone can never show a recorded
// refund (F2): a FULL refund cancels the subscription (a `CANCELED`
// SubscriptionEvent whose reason starts "Refunded in full…", plus the
// linked one-time purchase flipped to `REFUNDED`); a PARTIAL refund
// keeps the subscription and writes a `REFUNDED` SubscriptionEvent.
// There is no `REFUNDED` value on SubscriptionStatus — the refund
// signal for a subscription IS those timeline events, so the refunded
// tab matches on them (and on the linked purchase status), not only
// on the BillingEvent kind. `applyRefund` itself is untouched.
//
// The reason check is a `contains` at the DB level so a normal
// provider cancel ("Canceled by stripe (canceled)") never matches:
// both refund-cancel reasons contain "refunded in full"
// ("Refunded in full by <provider>…" and "One-time purchase refunded
// in full by <provider>").
async function findRefundedLinks(): Promise<{
  subscriptionIds: Set<string>
  purchaseIds: Set<string>
  userIds: Set<string>
}> {
  const [refundSubEvents, refundedPurchases] = await Promise.all([
    db.subscriptionEvent.findMany({
      where: {
        OR: [
          { type: "REFUNDED" },
          {
            type: "CANCELED",
            reason: { contains: "refunded in full", mode: "insensitive" },
          },
        ],
      },
      select: { subscriptionId: true },
    }),
    db.oneTimePurchase.findMany({
      where: { status: "REFUNDED" },
      select: { id: true, subscriptionId: true, userId: true },
    }),
  ])
  const subscriptionIds = new Set<string>(
    refundSubEvents.map((event) => event.subscriptionId)
  )
  for (const purchase of refundedPurchases) {
    if (purchase.subscriptionId) subscriptionIds.add(purchase.subscriptionId)
  }
  const purchaseIds = new Set(refundedPurchases.map((p) => p.id))
  const subOwners =
    subscriptionIds.size > 0
      ? await db.subscription.findMany({
          where: { id: { in: [...subscriptionIds] } },
          select: { userId: true },
        })
      : []
  const userIds = new Set<string>([
    ...subOwners.map((sub) => sub.userId),
    ...refundedPurchases.map((p) => p.userId),
  ])
  return { subscriptionIds, purchaseIds, userIds }
}

// Is one already-built payment row refund-linked? The event kind
// `PAYMENT_REFUNDED` is the webhook-recorded refund; the other two
// arms are the `applyRefund` record (F2): the row's resolved
// subscription is refund-linked, or its resolved purchase is.
function isRefundedRow(
  row: PaymentRow,
  links: { subscriptionIds: Set<string>; purchaseIds: Set<string> }
): boolean {
  if (row.kind === "PAYMENT_REFUNDED") return true
  if (
    row.sourceRefs.oneTimePurchaseId !== null &&
    links.purchaseIds.has(row.sourceRefs.oneTimePurchaseId)
  ) {
    return true
  }
  return (
    row.subscriptionId !== null && links.subscriptionIds.has(row.subscriptionId)
  )
}

// Candidate-event cap for the refunded tab (F2): the tab post-filters
// by refund linkage, which no DB filter can express (the link is the
// amount-resolution join), so it reads the newest candidates and
// filters in memory. Refunded users are rare, so 500 newest events
// across them is far more than a real refunded list — but the cap is
// real: beyond it, older refunded payments fall off this tab (they
// stay visible on the All tab and in the stats).
const REFUNDED_TAB_CANDIDATE_CAP = 500

// ─── Query helpers ────────────────────────────────────────────────────

// `q` searches the customer by email, name, or user id. Returns null
// when there is no `q` (no user filter), or the matching ids — an
// empty list when nothing matches, which the caller reads as "no
// rows" instead of running an unfiltered list.
async function resolveUserIdsForQuery(q?: string): Promise<string[] | null> {
  const needle = q?.trim()
  if (!needle) return null
  const [byId, byEmail, byName] = await Promise.all([
    db.user.findUnique({
      where: { id: needle },
      select: { id: true },
    }),
    db.user.findMany({
      where: { email: { contains: needle, mode: "insensitive" } },
      select: { id: true },
      take: 50,
    }),
    db.user.findMany({
      where: { name: { contains: needle, mode: "insensitive" } },
      select: { id: true },
      take: 50,
    }),
  ])
  return [
    ...new Set([
      ...(byId ? [byId.id] : []),
      ...byEmail.map((u) => u.id),
      ...byName.map((u) => u.id),
    ]),
  ]
}

function dateRangeFilter(filters: {
  from?: string
  to?: string
}): { gte?: Date; lte?: Date } | undefined {
  const range: { gte?: Date; lte?: Date } = {}
  if (filters.from) {
    const d = new Date(filters.from)
    if (!Number.isNaN(d.getTime())) range.gte = d
  }
  if (filters.to) {
    const d = new Date(filters.to)
    if (!Number.isNaN(d.getTime())) range.lte = d
  }
  return Object.keys(range).length > 0 ? range : undefined
}

// ─── Amount resolution ────────────────────────────────────────────────

type AmountMatch = {
  amountMinor: number | null
  currency: string | null
  subscriptionId: string | null
  checkoutAttemptId: string | null
  providerCheckoutId: string | null
  providerReference: string | null
  oneTimePurchaseId: string | null
  // Payments display fix: what the user actually paid, next to the
  // undiscounted price. amountMinor keeps its existing meaning (full
  // plan price for subscriptions, discounted amount for purchases /
  // attempts) so stats and existing callers are unchanged. All three
  // are null when the amount is unknown or no discount applies.
  discountAmountMinor: number | null
  paidAmountMinor: number | null
  fullAmountMinor: number | null
}

const UNKNOWN_AMOUNT: AmountMatch = {
  amountMinor: null,
  currency: null,
  subscriptionId: null,
  checkoutAttemptId: null,
  providerCheckoutId: null,
  providerReference: null,
  oneTimePurchaseId: null,
  discountAmountMinor: null,
  paidAmountMinor: null,
  fullAmountMinor: null,
}

// Derive the discount triple from an undiscounted full price and the
// amount actually paid. The discount is only set when it is strictly
// positive — a zero discount is "no discount", not a discount of 0.
function withDiscount(
  full: number | null,
  paid: number | null
): Pick<
  AmountMatch,
  "discountAmountMinor" | "paidAmountMinor" | "fullAmountMinor"
> {
  const discount =
    full !== null && paid !== null && full > paid ? full - paid : null
  return {
    discountAmountMinor: discount,
    paidAmountMinor: paid,
    fullAmountMinor: full,
  }
}

type EventAmountInput = {
  id: string
  provider: BillingProvider
  providerEventId: string
  userId: string | null
  createdAt: Date
}

async function resolveEventAmounts(
  events: EventAmountInput[]
): Promise<Map<string, AmountMatch>> {
  const result = new Map<string, AmountMatch>()
  if (events.length === 0) return result
  const providers = [...new Set(events.map((e) => e.provider))]
  const userIds = [
    ...new Set(
      events.map((e) => e.userId).filter((id): id is string => id !== null)
    ),
  ]
  const minAt = Math.min(...events.map((e) => e.createdAt.getTime()))
  const maxAt = Math.max(...events.map((e) => e.createdAt.getTime()))

  // 1. Exact: SubscriptionEvent.providerEventId (renewals, DB-010).
  // The match key is the BillingEvent's providerEventId (the provider's
  // evt_… id), NOT the BillingEvent cuid id: the webhook path stores the
  // provider event id on SubscriptionEvent, so matching on the cuid can
  // never hit (F1 — Phase B).
  const providerEventIds = [...new Set(events.map((e) => e.providerEventId))]
  const subEvents = await db.subscriptionEvent.findMany({
    where: { providerEventId: { in: providerEventIds } },
    select: { subscriptionId: true, providerEventId: true },
    orderBy: { createdAt: "asc" },
  })
  const subscriptionIdByEvent = new Map<string, string>()
  for (const row of subEvents) {
    if (
      row.providerEventId &&
      !subscriptionIdByEvent.has(row.providerEventId)
    ) {
      subscriptionIdByEvent.set(row.providerEventId, row.subscriptionId)
    }
  }
  const subsById = new Map<
    string,
    {
      id: string
      planVersion: { priceAmount: number | null; priceCurrency: string }
    }
  >()
  const exactSubIds = [...new Set(subEvents.map((row) => row.subscriptionId))]
  if (exactSubIds.length > 0) {
    const subs = await db.subscription.findMany({
      where: { id: { in: exactSubIds } },
      include: {
        planVersion: { select: { priceAmount: true, priceCurrency: true } },
      },
    })
    for (const sub of subs) subsById.set(sub.id, sub)
  }

  // 2. One-time purchases in a tight ±1h window around the event.
  const purchases =
    userIds.length > 0
      ? await db.oneTimePurchase.findMany({
          where: {
            provider: { in: providers },
            userId: { in: userIds },
            createdAt: {
              gte: new Date(minAt - PURCHASE_MATCH_BEFORE_MS),
              lte: new Date(maxAt + PURCHASE_MATCH_AFTER_MS),
            },
          },
          orderBy: { createdAt: "desc" },
        })
      : []

  // 3. Completed checkout attempts created within 24h before the event.
  const attempts =
    userIds.length > 0
      ? await db.checkoutAttempt.findMany({
          where: {
            provider: { in: providers },
            userId: { in: userIds },
            status: "COMPLETED",
            createdAt: {
              gte: new Date(minAt - AMOUNT_MATCH_WINDOW_MS),
              lte: new Date(maxAt),
            },
          },
          orderBy: { createdAt: "desc" },
        })
      : []

  // 4. Fallback: the latest subscription per (provider, user).
  const fallbackByPair = new Map<
    string,
    {
      id: string
      planVersion: { priceAmount: number | null; priceCurrency: string }
    }
  >()
  if (userIds.length > 0) {
    const subs = await db.subscription.findMany({
      where: { provider: { in: providers }, userId: { in: userIds } },
      include: {
        planVersion: { select: { priceAmount: true, priceCurrency: true } },
      },
      orderBy: { createdAt: "desc" },
    })
    for (const sub of subs) {
      const key = `${sub.provider}:${sub.userId}`
      if (!fallbackByPair.has(key)) fallbackByPair.set(key, sub)
    }
  }

  // 5. Discounts (Payments display fix). A subscription payment's
  // discount is its CouponRedemption (grant-time, minor units
  // actually discounted — latest redemption per subscription); a
  // one-time purchase's full price is its PlanVersion's price (the
  // purchase stores the discounted amount). A redemption in another
  // currency than the plan price is ignored — amounts in different
  // currencies are never subtracted.
  const discountSubIds = [
    ...new Set([
      ...exactSubIds,
      ...[...fallbackByPair.values()].map((sub) => sub.id),
    ]),
  ]
  const purchaseVersionIds = [...new Set(purchases.map((p) => p.planVersionId))]
  const [redemptions, versions] = await Promise.all([
    discountSubIds.length > 0
      ? db.couponRedemption.findMany({
          where: { subscriptionId: { in: discountSubIds } },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve([]),
    purchaseVersionIds.length > 0
      ? db.planVersion.findMany({
          where: { id: { in: purchaseVersionIds } },
          select: { id: true, priceAmount: true },
        })
      : Promise.resolve([]),
  ])
  const redemptionBySub = new Map<
    string,
    { discountAmount: number; currency: string }
  >()
  for (const row of redemptions) {
    if (row.subscriptionId && !redemptionBySub.has(row.subscriptionId)) {
      redemptionBySub.set(row.subscriptionId, {
        discountAmount: row.discountAmount,
        currency: row.currency,
      })
    }
  }
  const purchaseVersionPrice = new Map<string, number | null>()
  for (const version of versions) {
    purchaseVersionPrice.set(version.id, version.priceAmount)
  }

  for (const event of events) {
    const exactSubId = subscriptionIdByEvent.get(event.providerEventId)
    if (exactSubId) {
      const sub = subsById.get(exactSubId)
      if (sub) {
        const full = sub.planVersion.priceAmount
        const redemption = redemptionBySub.get(sub.id)
        const discount =
          redemption && redemption.currency === sub.planVersion.priceCurrency
            ? Math.min(Math.max(redemption.discountAmount, 0), full ?? 0)
            : 0
        result.set(event.id, {
          amountMinor: sub.planVersion.priceAmount,
          currency: sub.planVersion.priceCurrency,
          subscriptionId: sub.id,
          checkoutAttemptId: null,
          providerCheckoutId: null,
          providerReference: null,
          oneTimePurchaseId: null,
          ...withDiscount(full, full === null ? null : full - discount),
        })
        continue
      }
    }
    // Closest purchase in the ±1h window, same provider + user.
    let bestPurchase: (typeof purchases)[number] | null = null
    let bestPurchaseGap = Number.POSITIVE_INFINITY
    for (const purchase of purchases) {
      if (
        purchase.provider !== event.provider ||
        purchase.userId !== event.userId
      ) {
        continue
      }
      const gap = Math.abs(
        purchase.createdAt.getTime() - event.createdAt.getTime()
      )
      if (gap < bestPurchaseGap) {
        bestPurchaseGap = gap
        bestPurchase = purchase
      }
    }
    if (bestPurchase) {
      result.set(event.id, {
        amountMinor: bestPurchase.priceAmount,
        currency: bestPurchase.priceCurrency,
        subscriptionId: bestPurchase.subscriptionId,
        checkoutAttemptId: null,
        providerCheckoutId: bestPurchase.checkoutId,
        providerReference: bestPurchase.providerReference,
        oneTimePurchaseId: bestPurchase.id,
        ...withDiscount(
          purchaseVersionPrice.get(bestPurchase.planVersionId) ?? null,
          bestPurchase.priceAmount
        ),
      })
      continue
    }
    // Closest completed attempt created at most 24h before the event.
    let bestAttempt: (typeof attempts)[number] | null = null
    let bestAttemptGap = Number.POSITIVE_INFINITY
    for (const attempt of attempts) {
      if (
        attempt.provider !== event.provider ||
        attempt.userId !== event.userId
      ) {
        continue
      }
      const gap = event.createdAt.getTime() - attempt.createdAt.getTime()
      if (gap < 0 || gap > AMOUNT_MATCH_WINDOW_MS) continue
      if (gap < bestAttemptGap) {
        bestAttemptGap = gap
        bestAttempt = attempt
      }
    }
    if (bestAttempt) {
      // CheckoutAttempt.priceAmount is the DISCOUNTED amount actually
      // charged (billing service); the discount it carries is
      // discountAmountMinor (Phase D), so the full price is paid +
      // discount.
      const paid = bestAttempt.priceAmount
      const discount = bestAttempt.discountAmountMinor ?? 0
      result.set(event.id, {
        amountMinor: bestAttempt.priceAmount,
        currency: bestAttempt.priceCurrency,
        subscriptionId: null,
        checkoutAttemptId: bestAttempt.id,
        providerCheckoutId: bestAttempt.providerCheckoutId,
        providerReference: null,
        oneTimePurchaseId: null,
        ...withDiscount(
          paid === null ? null : paid + Math.max(discount, 0),
          paid
        ),
      })
      continue
    }
    if (event.userId) {
      const fallback = fallbackByPair.get(`${event.provider}:${event.userId}`)
      if (fallback) {
        const full = fallback.planVersion.priceAmount
        const redemption = redemptionBySub.get(fallback.id)
        const discount =
          redemption &&
          redemption.currency === fallback.planVersion.priceCurrency
            ? Math.min(Math.max(redemption.discountAmount, 0), full ?? 0)
            : 0
        result.set(event.id, {
          amountMinor: fallback.planVersion.priceAmount,
          currency: fallback.planVersion.priceCurrency,
          subscriptionId: fallback.id,
          checkoutAttemptId: null,
          providerCheckoutId: null,
          providerReference: null,
          oneTimePurchaseId: null,
          ...withDiscount(full, full === null ? null : full - discount),
        })
        continue
      }
    }
    result.set(event.id, UNKNOWN_AMOUNT)
  }
  return result
}

// A purchase is covered when a payment-kind event exists for the
// same provider + user within ±24h — the webhook path writes the
// event row first and the purchase seconds later.
async function findCoveredPurchaseIds(
  purchases: {
    id: string
    provider: BillingProvider
    userId: string
    createdAt: Date
  }[]
): Promise<Set<string>> {
  if (purchases.length === 0) return new Set()
  const providers = [...new Set(purchases.map((p) => p.provider))]
  const userIds = [...new Set(purchases.map((p) => p.userId))]
  const minAt = Math.min(...purchases.map((p) => p.createdAt.getTime()))
  const maxAt = Math.max(...purchases.map((p) => p.createdAt.getTime()))
  const events = await db.billingEvent.findMany({
    where: {
      kind: { in: PAYMENT_KINDS },
      provider: { in: providers },
      userId: { in: userIds },
      createdAt: {
        gte: new Date(minAt - AMOUNT_MATCH_WINDOW_MS),
        lte: new Date(maxAt + AMOUNT_MATCH_WINDOW_MS),
      },
    },
    select: { provider: true, userId: true, createdAt: true },
  })
  const covered = new Set<string>()
  for (const purchase of purchases) {
    for (const event of events) {
      if (
        event.provider === purchase.provider &&
        event.userId === purchase.userId &&
        Math.abs(event.createdAt.getTime() - purchase.createdAt.getTime()) <=
          AMOUNT_MATCH_WINDOW_MS
      ) {
        covered.add(purchase.id)
        break
      }
    }
  }
  return covered
}

// ─── Row builders ─────────────────────────────────────────────────────

function toPaymentRow(
  event: {
    id: string
    provider: BillingProvider
    providerEventId: string
    eventType: string
    kind: BillingEventKind | null
    userId: string | null
    createdAt: Date
  },
  match: AmountMatch | undefined,
  user: PaymentUser | null
): PaymentRow | null {
  // The list query filters kind IN PAYMENT_KINDS; any other kind
  // reaching here (e.g. through a mocked db) is not a payment row.
  if (event.kind === null || !isPaymentEventKind(event.kind)) return null
  const m = match ?? UNKNOWN_AMOUNT
  return {
    id: event.id,
    source: "billing-event",
    at: event.createdAt,
    userId: event.userId,
    user,
    provider: event.provider,
    kind: event.kind,
    eventType: event.eventType,
    amountMinor: m.amountMinor,
    currency: m.currency,
    discountAmountMinor: m.discountAmountMinor,
    paidAmountMinor: m.paidAmountMinor,
    fullAmountMinor: m.fullAmountMinor,
    status: statusForEventKind(event.kind),
    subscriptionId: m.subscriptionId,
    sourceRefs: {
      billingEventId: event.id,
      providerEventId: event.providerEventId,
      checkoutAttemptId: m.checkoutAttemptId,
      providerCheckoutId: m.providerCheckoutId,
      providerReference: m.providerReference,
      oneTimePurchaseId: m.oneTimePurchaseId,
    },
  }
}

function toPurchaseRow(
  purchase: {
    id: string
    provider: BillingProvider
    userId: string
    priceAmount: number | null
    priceCurrency: string
    status: OneTimePurchaseStatus
    subscriptionId: string | null
    providerReference: string
    checkoutId: string | null
    createdAt: Date
  },
  user: PaymentUser | null,
  // Undiscounted one-time price from the purchase's PlanVersion (the
  // purchase stores the discounted amount); null when unknown — the
  // row then shows the recorded amount only, as before.
  fullAmountMinor: number | null = null
): PaymentRow {
  return {
    id: purchase.id,
    source: "one-time-purchase",
    at: purchase.createdAt,
    userId: purchase.userId,
    user,
    provider: purchase.provider,
    kind: "ONE_TIME_PURCHASE",
    eventType: null,
    amountMinor: purchase.priceAmount,
    currency: purchase.priceCurrency,
    ...withDiscount(fullAmountMinor, purchase.priceAmount),
    status: purchase.status === "REFUNDED" ? "REFUNDED" : "SUCCEEDED",
    subscriptionId: purchase.subscriptionId,
    sourceRefs: {
      billingEventId: null,
      providerEventId: null,
      checkoutAttemptId: null,
      providerCheckoutId: purchase.checkoutId,
      providerReference: purchase.providerReference,
      oneTimePurchaseId: purchase.id,
    },
  }
}

async function loadUsersById(
  userIds: (string | null)[]
): Promise<Map<string, PaymentUser>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))]
  if (ids.length === 0) return new Map()
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, email: true },
  })
  return new Map(users.map((u) => [u.id, u]))
}

// Undiscounted one-time prices for standalone purchase rows (the
// purchase stores the discounted amount — Payments display fix).
async function loadPlanVersionPrices(
  planVersionIds: string[]
): Promise<Map<string, number | null>> {
  const ids = [...new Set(planVersionIds)]
  if (ids.length === 0) return new Map()
  const versions = await db.planVersion.findMany({
    where: { id: { in: ids } },
    select: { id: true, priceAmount: true },
  })
  return new Map(versions.map((v) => [v.id, v.priceAmount]))
}

// ─── List ─────────────────────────────────────────────────────────────

// The payment list (plan §3.5): every payment-kind BillingEvent
// exactly once with an amount (or "unknown"), plus every
// OneTimePurchase exactly once — covered purchases ride on their
// event row, uncovered ones get their own row. A CheckoutAttempt is
// never a row on its own (it is not a payment).
export async function listPayments(
  actor: AdminSession,
  filters: PaymentsQuery
): Promise<PaymentsPage> {
  requireBillingAdmin(actor, "VIEW_BILLING")
  const tab = filters.tab ?? "all"
  const qUserIds = await resolveUserIdsForQuery(filters.q)
  if (qUserIds !== null && qUserIds.length === 0) {
    return {
      payments: [],
      total: 0,
      page: filters.page,
      perPage: filters.perPage,
      totalPages: 1,
    }
  }
  // F2 (Wave 11): the refunded tab cannot be a kind filter — see
  // listRefundedPayments below. Every other tab is unchanged.
  if (tab === "refunded") {
    return listRefundedPayments(actor, filters, qUserIds)
  }
  const kinds = kindsForTab(tab)
  const purchaseStatuses = purchaseStatusesForTab(tab)
  const userIds = qUserIds ?? (filters.userId ? [filters.userId] : undefined)
  const createdAt = dateRangeFilter(filters)
  const eventWhere = {
    kind: { in: kinds },
    ...(filters.provider ? { provider: filters.provider } : {}),
    ...(userIds ? { userId: { in: userIds } } : {}),
    ...(createdAt ? { createdAt } : {}),
  }
  const skip = (filters.page - 1) * filters.perPage
  const [eventTotal, eventRows] = await Promise.all([
    db.billingEvent.count({ where: eventWhere }),
    db.billingEvent.findMany({
      where: eventWhere,
      orderBy: { createdAt: "desc" },
      skip,
      take: filters.perPage,
    }),
  ])

  let standaloneTotal = 0
  let standaloneRows: Awaited<ReturnType<typeof db.oneTimePurchase.findMany>> =
    []
  if (purchaseStatuses.length > 0) {
    const purchaseWhere = {
      status: { in: purchaseStatuses },
      ...(filters.provider ? { provider: filters.provider } : {}),
      ...(userIds ? { userId: { in: userIds } } : {}),
      ...(createdAt ? { createdAt } : {}),
    }
    // One-time purchases are a small table; the full filtered fetch
    // is what lets coverage be computed exactly (see the header
    // comment on pagination for the merge rule).
    const allPurchases = await db.oneTimePurchase.findMany({
      where: purchaseWhere,
      orderBy: { createdAt: "desc" },
    })
    const covered = await findCoveredPurchaseIds(allPurchases)
    const standalone = allPurchases.filter((p) => !covered.has(p.id))
    standaloneTotal = standalone.length
    standaloneRows = standalone.slice(skip, skip + filters.perPage)
  }

  const amounts = await resolveEventAmounts(eventRows)
  const usersById = await loadUsersById([
    ...eventRows.map((e) => e.userId),
    ...standaloneRows.map((p) => p.userId),
  ])
  const planVersionPrices = await loadPlanVersionPrices(
    standaloneRows.map((p) => p.planVersionId)
  )
  const rows = [
    ...eventRows.flatMap((event) => {
      const row = toPaymentRow(
        event,
        amounts.get(event.id),
        event.userId ? (usersById.get(event.userId) ?? null) : null
      )
      return row ? [row] : []
    }),
    ...standaloneRows.map((purchase) =>
      toPurchaseRow(
        purchase,
        usersById.get(purchase.userId) ?? null,
        planVersionPrices.get(purchase.planVersionId) ?? null
      )
    ),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, filters.perPage)
  const total = eventTotal + standaloneTotal
  return {
    payments: rows,
    total,
    page: filters.page,
    perPage: filters.perPage,
    totalPages: Math.max(1, Math.ceil(total / filters.perPage)),
  }
}

// The Refunded tab (F2, Wave 11). `applyRefund` writes no
// `PAYMENT_REFUNDED` BillingEvent, so matching on the event kind alone
// leaves this tab empty after a recorded refund. The tab therefore
// ALSO matches event rows whose linked subscription/purchase is
// refunded (`isRefundedRow`): a `PAYMENT_SUCCEEDED` /
// `CHECKOUT_COMPLETED` row for a refund-canceled or partially-refunded
// subscription shows here, with its status overridden to `REFUNDED`.
// The row keeps its original kind (it did succeed — and was later
// refunded), so it still appears on the Succeeded / All tabs; only the
// status shown on this tab changes.
//
// Candidate events are the `PAYMENT_REFUNDED` rows for anyone (a
// provider refund with no local subscription/purchase still counts)
// plus the succeeded/completed/unmapped rows of users with a refund
// link. `PAYMENT_FAILED` rows can never be refunded and are excluded.
// Pagination is in-memory after the refund filter (the link is the
// amount-resolution join, which no DB filter can express), bounded by
// REFUNDED_TAB_CANDIDATE_CAP.
async function listRefundedPayments(
  actor: AdminSession,
  filters: PaymentsQuery,
  qUserIds: string[] | null
): Promise<PaymentsPage> {
  requireBillingAdmin(actor, "VIEW_BILLING")
  const links = await findRefundedLinks()
  const userIds = qUserIds ?? (filters.userId ? [filters.userId] : undefined)
  const createdAt = dateRangeFilter(filters)
  const shared = {
    ...(filters.provider ? { provider: filters.provider } : {}),
    ...(userIds ? { userId: { in: userIds } } : {}),
    ...(createdAt ? { createdAt } : {}),
  }
  const refundedUserIds = [...links.userIds].filter(
    (id) => !userIds || userIds.includes(id)
  )
  const candidateEvents = await db.billingEvent.findMany({
    where: {
      OR: [
        // `as BillingEventKind[]`: without it the literals widen to
        // string[] through the spread below and fail the Prisma where
        // type (TS2322).
        { ...shared, kind: { in: ["PAYMENT_REFUNDED"] as BillingEventKind[] } },
        ...(refundedUserIds.length > 0
          ? [
              {
                ...shared,
                kind: {
                  in: [
                    "CHECKOUT_COMPLETED",
                    "PAYMENT_SUCCEEDED",
                    "UNMAPPED_PAYMENT",
                  ] as BillingEventKind[],
                },
                userId: { in: refundedUserIds },
              },
            ]
          : []),
      ],
    },
    orderBy: { createdAt: "desc" },
    take: REFUNDED_TAB_CANDIDATE_CAP,
  })
  const amounts = await resolveEventAmounts(candidateEvents)

  // Standalone REFUNDED purchases (same logic as the main list: a
  // purchase with no covering event is its own row).
  const purchaseWhere = {
    status: { in: ["REFUNDED"] as OneTimePurchaseStatus[] },
    ...(filters.provider ? { provider: filters.provider } : {}),
    ...(userIds ? { userId: { in: userIds } } : {}),
    ...(createdAt ? { createdAt } : {}),
  }
  const allRefundedPurchases = await db.oneTimePurchase.findMany({
    where: purchaseWhere,
    orderBy: { createdAt: "desc" },
  })
  const covered = await findCoveredPurchaseIds(allRefundedPurchases)
  const standalonePurchases = allRefundedPurchases.filter(
    (p) => !covered.has(p.id)
  )

  const usersById = await loadUsersById([
    ...candidateEvents.map((e) => e.userId),
    ...standalonePurchases.map((p) => p.userId),
  ])
  const planVersionPrices = await loadPlanVersionPrices(
    standalonePurchases.map((p) => p.planVersionId)
  )
  const eventRows = candidateEvents.flatMap((event) => {
    const row = toPaymentRow(
      event,
      amounts.get(event.id),
      event.userId ? (usersById.get(event.userId) ?? null) : null
    )
    if (!row || !isRefundedRow(row, links)) return []
    // The row was a successful payment that was later refunded:
    // show REFUNDED on this tab (its kind is unchanged).
    return [{ ...row, status: "REFUNDED" as PaymentStatus }]
  })
  const rows = [
    ...eventRows,
    ...standalonePurchases.map((purchase) =>
      toPurchaseRow(
        purchase,
        usersById.get(purchase.userId) ?? null,
        planVersionPrices.get(purchase.planVersionId) ?? null
      )
    ),
  ].sort((a, b) => b.at.getTime() - a.at.getTime())
  const total = rows.length
  const skip = (filters.page - 1) * filters.perPage
  return {
    payments: rows.slice(skip, skip + filters.perPage),
    total,
    page: filters.page,
    perPage: filters.perPage,
    totalPages: Math.max(1, Math.ceil(total / filters.perPage)),
  }
}

// ─── Stats ────────────────────────────────────────────────────────────

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function toBucket(rows: PaymentRow[]): PaymentStatsBucket {
  const known = rows.filter(
    (row): row is PaymentRow & { amountMinor: number; currency: string } =>
      row.amountMinor !== null && row.currency !== null
  )
  const byCurrency = new Map<string, number>()
  for (const row of known) {
    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + 1)
  }
  const currency =
    [...byCurrency.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    )[0]?.[0] ?? null
  // Amounts in different currencies are never added together: the
  // sum covers the majority currency's rows only.
  const amountMinor =
    currency === null
      ? 0
      : known
          .filter((row) => row.currency === currency)
          .reduce((sum, row) => sum + row.amountMinor, 0)
  return {
    count: rows.length,
    amountMinor,
    currency,
    unknownCount: rows.length - known.length,
  }
}

// 30-day stat row (plan §3.5): paid / failed / refunded amounts
// summed from the same join as the list. A Stripe subscription
// payment fires BOTH checkout.session.completed
// (CHECKOUT_COMPLETED) and invoice.paid (PAYMENT_SUCCEEDED) for the
// one payment — the paid bucket drops the PAYMENT_SUCCEEDED row when
// a CHECKOUT_COMPLETED row exists for the same subscription, amount,
// and UTC day, so the one payment is not counted twice. The list
// keeps both rows (each is a real webhook event); only the stats
// dedup.
export async function getPaymentStats(
  actor: AdminSession,
  now: Date = new Date()
): Promise<PaymentStats> {
  requireBillingAdmin(actor, "VIEW_BILLING")
  const start = new Date(now.getTime() - THIRTY_DAYS_MS)
  const [events, purchases] = await Promise.all([
    db.billingEvent.findMany({
      where: {
        kind: { in: PAYMENT_KINDS },
        createdAt: { gte: start, lte: now },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.oneTimePurchase.findMany({
      where: { createdAt: { gte: start, lte: now } },
      orderBy: { createdAt: "desc" },
    }),
  ])
  const [amounts, covered, links] = await Promise.all([
    resolveEventAmounts(events),
    findCoveredPurchaseIds(purchases),
    // F2 (Wave 11): refunded money must not stay in the paid bucket —
    // a recorded refund moves its rows to the refunded bucket (same
    // linkage as the Refunded tab).
    findRefundedLinks(),
  ])
  const rows = [
    ...events.flatMap((event) => {
      const row = toPaymentRow(event, amounts.get(event.id), null)
      return row ? [row] : []
    }),
    ...purchases
      .filter((p) => !covered.has(p.id))
      .map((purchase) => toPurchaseRow(purchase, null)),
  ]
  const checkoutKeys = new Set(
    rows
      .filter(
        (row) =>
          row.kind === "CHECKOUT_COMPLETED" &&
          row.subscriptionId !== null &&
          row.amountMinor !== null
      )
      .map(
        (row) => `${row.subscriptionId}|${row.amountMinor}|${dayKey(row.at)}`
      )
  )
  const deduped = rows.filter(
    (row) =>
      !(
        row.kind === "PAYMENT_SUCCEEDED" &&
        row.subscriptionId !== null &&
        row.amountMinor !== null &&
        checkoutKeys.has(
          `${row.subscriptionId}|${row.amountMinor}|${dayKey(row.at)}`
        )
      )
  )
  return {
    paid30d: toBucket(
      deduped.filter(
        (row) =>
          !isRefundedRow(row, links) &&
          (row.kind === "CHECKOUT_COMPLETED" ||
            row.kind === "PAYMENT_SUCCEEDED" ||
            row.kind === "UNMAPPED_PAYMENT" ||
            (row.kind === "ONE_TIME_PURCHASE" && row.status === "SUCCEEDED"))
      )
    ),
    failed30d: toBucket(deduped.filter((row) => row.kind === "PAYMENT_FAILED")),
    refunded30d: toBucket(deduped.filter((row) => isRefundedRow(row, links))),
  }
}

// ─── Detail ───────────────────────────────────────────────────────────

async function loadSubscriptionForDetail(subscriptionId: string | null) {
  if (!subscriptionId) return null
  const subscription = await db.subscription.findUnique({
    where: { id: subscriptionId },
    select: {
      id: true,
      status: true,
      planVersionId: true,
      providerSubscriptionId: true,
      currentPeriodEnd: true,
    },
  })
  if (!subscription) return null
  const version = await db.planVersion.findUnique({
    where: { id: subscription.planVersionId },
    select: { plan: { select: { name: true } } },
  })
  return { ...subscription, planName: version?.plan.name ?? null }
}

// Single-payment read — none existed before this page (plan §3.5).
// The id is a BillingEvent id or a OneTimePurchase id; anything else
// is a 404.
export async function getPaymentDetail(
  actor: AdminSession,
  id: string
): Promise<PaymentDetail> {
  requireBillingAdmin(actor, "VIEW_BILLING")
  const event = await db.billingEvent.findUnique({ where: { id } })
  if (event) {
    if (event.kind === null || !PAYMENT_KINDS.includes(event.kind)) {
      throw new ApiError("Payment not found", 404)
    }
    const amounts = await resolveEventAmounts([event])
    const match = amounts.get(event.id)
    const user = event.userId
      ? await db.user.findUnique({
          where: { id: event.userId },
          select: { id: true, name: true, email: true },
        })
      : null
    const payment = toPaymentRow(event, match, user)
    if (!payment) throw new ApiError("Payment not found", 404)
    // F2 (Wave 11): a recorded refund must show on the detail too —
    // the row's event kind is still PAYMENT_SUCCEEDED, but its linked
    // subscription/purchase is refunded. Only SUCCEEDED rows need the
    // check; FAILED / REFUNDED rows already show their own status.
    if (
      match &&
      payment.status === "SUCCEEDED" &&
      isRefundedRow(payment, await findRefundedLinks())
    ) {
      payment.status = "REFUNDED"
    }
    let subscription = await loadSubscriptionForDetail(
      match?.subscriptionId ?? null
    )
    if (!subscription && event.userId) {
      const latest = await db.subscription.findFirst({
        where: { provider: event.provider, userId: event.userId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      })
      subscription = await loadSubscriptionForDetail(latest?.id ?? null)
    }
    const purchase = match?.oneTimePurchaseId
      ? await db.oneTimePurchase.findUnique({
          where: { id: match.oneTimePurchaseId },
          select: {
            id: true,
            providerReference: true,
            checkoutId: true,
            priceAmount: true,
            priceCurrency: true,
            status: true,
            accessStart: true,
            accessEnd: true,
          },
        })
      : null
    return {
      payment,
      event: {
        id: event.id,
        provider: event.provider,
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        kind: event.kind,
        processedAt: event.processedAt,
        createdAt: event.createdAt,
      },
      purchase,
      subscription,
    }
  }
  const purchase = await db.oneTimePurchase.findUnique({
    where: { id },
    select: {
      id: true,
      provider: true,
      userId: true,
      planVersionId: true,
      priceAmount: true,
      priceCurrency: true,
      status: true,
      subscriptionId: true,
      providerReference: true,
      checkoutId: true,
      accessStart: true,
      accessEnd: true,
      createdAt: true,
    },
  })
  if (!purchase) throw new ApiError("Payment not found", 404)
  const user = await db.user.findUnique({
    where: { id: purchase.userId },
    select: { id: true, name: true, email: true },
  })
  const planVersion = await db.planVersion.findUnique({
    where: { id: purchase.planVersionId },
    select: { priceAmount: true },
  })
  const payment = toPurchaseRow(
    purchase,
    user,
    planVersion?.priceAmount ?? null
  )
  const subscription = await loadSubscriptionForDetail(purchase.subscriptionId)
  return {
    payment,
    event: null,
    purchase: {
      id: purchase.id,
      providerReference: purchase.providerReference,
      checkoutId: purchase.checkoutId,
      priceAmount: purchase.priceAmount,
      priceCurrency: purchase.priceCurrency,
      status: purchase.status,
      accessStart: purchase.accessStart,
      accessEnd: purchase.accessEnd,
    },
    subscription,
  }
}

// ─── Refund ───────────────────────────────────────────────────────────

// Record an admin refund (plan §3.5, Q11: step-up required). Wires
// the EXISTING applyRefund in @sendcms/plans — its behavior is
// unchanged: a full refund cancels the matching subscription (and
// flips a linked one-time purchase to REFUNDED); a partial refund
// keeps the subscription and writes a REFUNDED timeline event.
// applyRefund makes NO provider call: the refund itself must already
// have been issued at the provider (the dialog says so); this route
// records its SendCMS-side effects and the audit row.
export async function refundPayment(
  actor: AdminSession,
  id: string,
  input: RefundPaymentInput
): Promise<PaymentRefundResult> {
  requireBillingAdmin(actor, "MANAGE_BILLING")
  // MANAGE_BILLING holders (owner + SUPER_ADMIN) also hold
  // VIEW_BILLING, so the detail re-read below cannot 403 them.
  const detail = await getPaymentDetail(actor, id)
  let providerSubscriptionId: string | null = null
  let providerReference: string | null = null
  if (detail.purchase) {
    if (detail.purchase.status === "REFUNDED") {
      throw new ApiError("This purchase was already refunded.", 409)
    }
    providerReference = detail.purchase.providerReference
  }
  if (detail.subscription) {
    providerSubscriptionId = detail.subscription.providerSubscriptionId
    const alreadyEnded =
      detail.subscription.status === "CANCELED" ||
      detail.subscription.status === "EXPIRED"
    if (alreadyEnded && !providerReference) {
      throw new ApiError(
        "This subscription is already canceled — there is nothing left to refund.",
        409
      )
    }
  }
  if (!providerSubscriptionId && !providerReference) {
    throw new ApiError(
      "No subscription or purchase matches this payment — nothing to refund.",
      422
    )
  }
  // Step-up (Phase 9): checked last, after every cheap guard,
  // immediately before the write — the admin-users disable pattern.
  // Consumes one unbound admin verification, so one password entry
  // authorizes exactly one refund.
  await requireStepUp(actor)
  const subscription = await applyRefund(detail.payment.provider, {
    providerSubscriptionId,
    providerReference,
    fullRefund: input.fullRefund,
    amountMinor: input.amountMinor ?? null,
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: detail.subscription
      ? AuditResource.SUBSCRIPTION
      : AuditResource.BILLING_PROVIDER,
    resourceId: detail.subscription?.id ?? id,
    detail: {
      event: "payment-refund-recorded",
      paymentId: id,
      provider: detail.payment.provider,
      fullRefund: input.fullRefund,
      amountMinor: input.amountMinor ?? null,
      reason: input.reason,
    },
  })
  const fresh = await getPaymentDetail(actor, id)
  return { payment: fresh, subscription }
}
