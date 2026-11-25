import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { listSubscriptions } from "@sendcms/plans"
import { SubscriptionListQuerySchema } from "@sendcms/plans/validators"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { SubscriptionsTable } from "@/components/admin/subscriptions-table"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "subscriptions")
  return {
    title: `${t("title")} — SendCMS Admin`,
    description: t("description"),
  }
}

// Admin subscription list (Phase 4). Same shape as the plans page:
// the server fetches the first page via the service layer and passes
// it as initialData; the client table owns filters and pagination
// (URL-as-state). The actor's effective role goes down so the UI can
// hide actions the actor cannot perform — the service enforces
// authorization server-side regardless.
export default async function AdminSubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const filters = SubscriptionListQuerySchema.parse(await searchParams)
  const initialData = await listSubscriptions(session, filters)

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "subscriptions")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <SubscriptionsTable
        initialData={initialData}
        filters={filters}
        actorRole={actorRole}
      />
    </main>
  )
}
