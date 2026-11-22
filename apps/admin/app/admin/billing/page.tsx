import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { BillingOverview } from "@/components/admin/billing-overview"

export const metadata: Metadata = {
  title: "Billing — SendCMS Admin",
  description: "Manage payment providers, their countries, and checkout.",
}

// Billing providers (Phase 8). The server only authenticates and
// resolves the actor's role; the client component reads the provider
// configs and the country list through the api app.
export default async function AdminBillingPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "billing")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <BillingOverview actorRole={actorRole} />
    </main>
  )
}
