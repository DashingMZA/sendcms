import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { MigrationWizard } from "@/components/admin/migration-wizard"

export const metadata: Metadata = {
  title: "Migrate subscriptions — SendCMS Admin",
  description: "Migrate selected subscriptions to a new plan version.",
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

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "subscriptions")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("migrateTitle")}
        </h1>
        <p className="text-muted-foreground">{t("migrateDescription")}</p>
      </div>
      <MigrationWizard actorRole={actorRole} />
    </main>
  )
}
