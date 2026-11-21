import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { listPlans } from "@sendcms/plans"
import { PlanListQuerySchema } from "@sendcms/plans/validators"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PlansTable } from "@/components/admin/plans-table"

export const metadata: Metadata = {
  title: "Plans — SendCMS Admin",
  description: "Create and manage versioned plans.",
}

// Admin plan list (Phase 4). The server fetches the first page via the
// service layer and passes it as initialData; the client table owns
// search, filters, and pagination from there (URL-as-state, like the
// users table). The actor's effective role goes down so the UI can hide
// actions the actor cannot perform — the service enforces authorization
// server-side regardless.
export default async function AdminPlansPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const filters = PlanListQuerySchema.parse(await searchParams)
  const initialData = await listPlans(session, filters)

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "plans")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <PlansTable
        initialData={initialData}
        filters={filters}
        actorRole={actorRole}
      />
    </main>
  )
}
