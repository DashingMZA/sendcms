// Plans & Subscriptions tabs (Phase A, plan §3.3 — Wave 10 UX-105).
//
// A thin client shell around the two EXISTING tables. The tables are
// passed in as nodes from the server page (composition, not imports),
// so this shell stays free of server-only imports and of the tables'
// own data hooks. Only the active tab's table is mounted (Radix Tabs
// unmounts inactive content), so the two tables never fight over the
// one shared URL query string while both are on screen — and the page
// parses each table's filters with safeParse + defaults, because the
// two status/sort enums are disjoint (a status left by one table
// would fail the other's parse).
"use client"

import { useState, type ReactNode } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@sendcms/ui"

type Props = {
  /** False for actors without VIEW_PLAN_VERSIONS (e.g. SUPPORT): the
      Plans tab is hidden entirely and Subscriptions is the default. */
  canViewPlans: boolean
  labels: { plans: string; subscriptions: string }
  plansTable?: ReactNode
  subscriptionsTable: ReactNode
}

export function PlansSubscriptionsTabs({
  canViewPlans,
  labels,
  plansTable,
  subscriptionsTable,
}: Props) {
  const [tab, setTab] = useState(canViewPlans ? "plans" : "subscriptions")
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="h-auto flex-wrap justify-start">
        {canViewPlans && (
          <TabsTrigger value="plans">{labels.plans}</TabsTrigger>
        )}
        <TabsTrigger value="subscriptions">{labels.subscriptions}</TabsTrigger>
      </TabsList>

      {canViewPlans && (
        <TabsContent value="plans" className="mt-6">
          {plansTable}
        </TabsContent>
      )}
      <TabsContent value="subscriptions" className="mt-6">
        {subscriptionsTable}
      </TabsContent>
    </Tabs>
  )
}
