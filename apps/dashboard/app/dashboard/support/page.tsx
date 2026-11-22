import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { listMyTickets } from "@sendcms/support"
import { MyTicketsQuerySchema } from "@sendcms/support/validators"
import { PageHeader } from "@/components/dashboard/page-header"
import {
  DASHBOARD_SUPPORT_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { SupportList } from "./support-list"

// The customer's support tickets (Phase 8). The server fetches the
// caller's own tickets and passes them as initialData; the client
// component owns the status filter and pagination through the URL.
export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/sign-in")

  const filters = MyTicketsQuerySchema.parse(await searchParams)
  const initialData = await listMyTickets(session.user.id, filters)

  const locale = await getRequestLocale(session.user.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_SUPPORT_DOMAINS)
  const t = await getTranslator(locale, "support")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />

      <div className="p-4 sm:p-6">
        <TranslationProvider dictionaries={dictionaries}>
          <SupportList initialData={initialData} filters={filters} />
        </TranslationProvider>
      </div>
    </div>
  )
}
