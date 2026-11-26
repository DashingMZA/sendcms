import { auth } from "@/lib/auth"
import { notFound, redirect } from "next/navigation"
import { getMyTicket } from "@sendcms/support"
import { ApiError } from "@sendcms/shared"
import { PageHeader } from "@/components/dashboard/page-header"
import { PageContent } from "@/components/dashboard/page-content"
import {
  DASHBOARD_SUPPORT_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { TicketThread } from "./ticket-thread"

// Customer thread page: the customer sees their own ticket and its
// messages, and can reply. A reply to a RESOLVED ticket reopens it;
// a CLOSED ticket is read-only (the service refuses replies with 409).
export default async function TicketPage({
  params,
}: {
  params: Promise<{ ticketId: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/sign-in")

  const { ticketId } = await params
  let ticket
  try {
    ticket = await getMyTicket(session.user.id, ticketId)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }

  const locale = await getRequestLocale(session.user.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_SUPPORT_DOMAINS)
  const t = await getTranslator(locale, "support")

  return (
    <div>
      <PageHeader title={ticket.subject} description={t("threadDescription")} />

      <PageContent>
        <TranslationProvider dictionaries={dictionaries}>
          <TicketThread ticket={ticket} />
        </TranslationProvider>
      </PageContent>
    </div>
  )
}
