import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { notFound, redirect } from "next/navigation"
import { adminCan } from "@sendcms/permissions"
import { getTicket, listStaffUsers } from "@sendcms/support"
import { ApiError } from "@sendcms/shared"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { SupportThread } from "@/components/admin/support-thread"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "support")
  return {
    title: `${t("ticketTitle")} — SendCMS Admin`,
    description: t("queueDescription"),
  }
}

// Admin support thread (Phase 8). The server fetches the ticket via
// the service layer and passes it as initialData; the client component
// owns the reply, status change, and assign forms. The staff list is
// only fetched for actors who may assign (MANAGE_USERS or SUPPORT) —
// other readers get the thread without it.
export default async function AdminSupportThreadPage({
  params,
}: {
  params: Promise<{ ticketId: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const { ticketId } = await params
  let ticket
  try {
    ticket = await getTicket(session, ticketId)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }

  const staffUsers =
    adminCan(actorRole, "MANAGE_USERS") || actorRole === "SUPPORT"
      ? await listStaffUsers(session)
      : []

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "support")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{ticket.subject}</h1>
        <p className="text-muted-foreground">{t("queueDescription")}</p>
      </div>
      <SupportThread
        initialData={ticket}
        staffUsers={staffUsers}
        actorRole={actorRole}
      />
    </main>
  )
}
