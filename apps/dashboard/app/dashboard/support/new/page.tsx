import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { PageHeader } from "@/components/dashboard/page-header"
import {
  DASHBOARD_SUPPORT_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { NewTicketForm } from "./new-ticket-form"

// A proper page for opening a ticket (Phase 8 UX rule: pages, not
// popups — the form lives here, not in a dialog on the list page).
export default async function NewTicketPage() {
  const session = await auth()
  if (!session?.user) redirect("/sign-in")

  const locale = await getRequestLocale(session.user.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_SUPPORT_DOMAINS)
  const t = await getTranslator(locale, "support")

  return (
    <div>
      <PageHeader
        title={t("newTicketTitle")}
        description={t("newTicketDescription")}
      />

      <div className="p-4 sm:p-6">
        <TranslationProvider dictionaries={dictionaries}>
          <NewTicketForm />
        </TranslationProvider>
      </div>
    </div>
  )
}
