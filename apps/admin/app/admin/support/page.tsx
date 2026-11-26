import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { listTickets } from "@sendcms/support"
import { AdminTicketsQuerySchema } from "@sendcms/support/validators"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { SupportQueue } from "@/components/admin/support-queue"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "support")
  return {
    title: `${t("queueTitle")} — SendCMS Admin`,
    description: t("queueDescription"),
  }
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

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "support")

  return (
    <div>
      <PageHeader title={t("queueTitle")} description={t("queueDescription")} />
      <main id="main-content" className="flex flex-col gap-6 p-6">
        <SupportQueue
          initialData={initialData}
          filters={filters}
          actorRole={actorRole}
        />
      </main>
    </div>
  )
}
