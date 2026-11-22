import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { listTickets } from "@sendcms/support"
import { AdminTicketsQuerySchema } from "@sendcms/support/validators"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { SupportQueue } from "@/components/admin/support-queue"

export const metadata: Metadata = {
  title: "Support — SendCMS Admin",
  description: "Manage customer support tickets.",
}

// Admin support queue (Phase 8). The server fetches the first page via
// the service layer and passes it as initialData; the client table owns
// the filters and pagination from there (URL-as-state, like the users
// table). Reads need VIEW_CUSTOMER_DATA (enforced in the service).
export default async function AdminSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const filters = AdminTicketsQuerySchema.parse(await searchParams)
  const initialData = await listTickets(session, filters)

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "support")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("queueTitle")}</h1>
        <p className="text-muted-foreground">{t("queueDescription")}</p>
      </div>
      <SupportQueue
        initialData={initialData}
        filters={filters}
        actorRole={actorRole}
      />
    </main>
  )
}
