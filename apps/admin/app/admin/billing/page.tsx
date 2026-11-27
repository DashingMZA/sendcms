import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { BillingEventsTable } from "@/components/admin/billing-events-table"
import { BillingOverview } from "@/components/admin/billing-overview"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "billing")
  return {
    title: `${t("title")} — SendCMS Admin`,
    description: t("description"),
  }
}

// Billing providers (Phase 8) + billing events (Wave 5, ADM-123 /
// BIL-123 / BIL-092): the webhook receipts and payment events the
// providers actually delivered. The server only authenticates and
// resolves the actor's role; the client components read through the
// api app.
export default async function AdminBillingPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "billing")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <div tabIndex={-1} className="flex flex-col gap-6 p-6">
        <BillingOverview actorRole={actorRole} />
        <BillingEventsTable actorRole={actorRole} />
      </div>
    </div>
  )
}
