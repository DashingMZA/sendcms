import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { notFound, redirect } from "next/navigation"
import { getPlan } from "@sendcms/plans"
import { ApiError } from "@sendcms/shared"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PlanDetailView } from "@/components/admin/plan-detail"

export const metadata: Metadata = {
  title: "Plan — SendCMS Admin",
  description: "Inspect and manage a plan and its versions.",
}

// Admin plan detail (Phase 4). The server fetches the plan via the
// service layer and passes it as initialData; the client component owns
// the version history, comparison, and every admin action. The actor's
// effective role goes down so the UI can hide actions the actor cannot
// perform — the service enforces authorization server-side regardless.
export default async function AdminPlanDetailPage({
  params,
}: {
  params: Promise<{ planId: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const { planId } = await params
  let detail
  try {
    detail = await getPlan(session, planId)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  return (
    <PlanDetailView
      initialData={detail}
      planId={planId}
      actorRole={actorRole}
    />
  )
}
