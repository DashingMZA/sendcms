import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { MigrationWizard } from "@/components/admin/migration-wizard"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "subscriptions")
  return {
    title: `${t("migrateTitle")} — SendCMS Admin`,
    description: t("migrateDescription"),
  }
}

// Subscription migration workflow (Phase 4). Client-owned wizard:
// pick a target plan version, pick a scope (all users on a source
// version, or specific users), preview the before/after, then confirm
// with a reason. The service enforces authorization + the migration
// rules server-side regardless of what the UI shows.
export default async function AdminMigrateSubscriptionsPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "subscriptions")

  return (
    <div>
      <PageHeader
        title={t("migrateTitle")}
        description={t("migrateDescription")}
        back={{ href: "/admin/subscriptions", label: t("backToSubscriptions") }}
      />
      <main id="main-content" className="flex flex-col gap-6 p-6">
        <MigrationWizard actorRole={actorRole} />
      </main>
    </div>
  )
}
