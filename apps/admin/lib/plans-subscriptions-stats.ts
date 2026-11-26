// Plans & Subscriptions stat row (Phase A, plan §3.3).
//
// The four counts are the totals of the same list queries the two
// embedded tables use (listPlans / listSubscriptions in @sendcms/plans),
// fetched with perPage: 1 — only the total is read. No new aggregation
// model: the stat row reconciles with /admin/plans and
// /admin/subscriptions by construction, because it IS those queries.
//
// getAdminOverview is deliberately not used here: its
// subscriptions.active is the same count listSubscriptions({
// status: "ACTIVE" }) returns, and calling the wide overview query
// for one number would add an unrelated read. The list totals are
// authoritative for reconciliation.
import type { AdminSession } from "@sendcms/auth"
import { listPlans, listSubscriptions } from "@sendcms/plans"

export type PlansSubscriptionsStats = {
  /** Null for actors without VIEW_PLAN_VERSIONS (e.g. SUPPORT): the
      plans list — and its count — is not visible to them, and
      listPlans would throw for them. */
  plansPublished: number | null
  subscriptionsActive: number
  subscriptionsTrialing: number
  subscriptionsPastDue: number
}

export async function getPlansSubscriptionsStats(
  session: AdminSession,
  canViewPlans: boolean
): Promise<PlansSubscriptionsStats> {
  const [
    plansPublished,
    subscriptionsActive,
    subscriptionsTrialing,
    subscriptionsPastDue,
  ] = await Promise.all([
    canViewPlans
      ? listPlans(session, {
          page: 1,
          perPage: 1,
          sort: "createdAt:desc",
          status: "PUBLISHED",
        }).then((result) => result.total)
      : Promise.resolve(null),
    listSubscriptions(session, {
      page: 1,
      perPage: 1,
      sort: "createdAt:desc",
      status: "ACTIVE",
    }).then((result) => result.total),
    listSubscriptions(session, {
      page: 1,
      perPage: 1,
      sort: "createdAt:desc",
      status: "TRIALING",
    }).then((result) => result.total),
    listSubscriptions(session, {
      page: 1,
      perPage: 1,
      sort: "createdAt:desc",
      status: "PAST_DUE",
    }).then((result) => result.total),
  ])
  return {
    plansPublished,
    subscriptionsActive,
    subscriptionsTrialing,
    subscriptionsPastDue,
  }
}
