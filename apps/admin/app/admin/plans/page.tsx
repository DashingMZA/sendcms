import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { listPlans } from "@sendcms/plans"
import { PlanListQuerySchema } from "@sendcms/plans/validators"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { PlansTable } from "@/components/admin/plans-table"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "plans")
  return {
    title: `${t("title")} — SendCMS Admin`,
    description: t("description"),
  }
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

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "plans")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <main id="main-content" className="flex flex-col gap-6 p-6">
        <PlansTable
          initialData={initialData}
          filters={filters}
          actorRole={actorRole}
        />
      </main>
    </div>
  )
}
