import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { PageHeader } from "@/components/dashboard/page-header"
import {
  DASHBOARD_BILLING_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { getMySubscription } from "@sendcms/billing"
import { BillingOverview } from "./billing-overview"

// The customer's billing page (Phase 8): the current subscription
// and a link to change plans. SRC-110: the server fetches the
// subscription and passes it as initialData, so the plan renders in
// the SSR HTML instead of after the client fetch. A successful
// provider checkout lands back here with ?checkout=success.
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/sign-in")

  const subscription = await getMySubscription(session.user.id)

  const locale = await getRequestLocale(session.user.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_BILLING_DOMAINS)
  const t = await getTranslator(locale, "billing")
  const checkoutSuccess = (await searchParams).checkout === "success"

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />

      <div className="p-4 sm:p-6">
        <TranslationProvider dictionaries={dictionaries}>
          <BillingOverview
            locale={locale}
            checkoutSuccess={checkoutSuccess}
            initialSubscription={subscription}
          />
        </TranslationProvider>
      </div>
    </div>
  )
}
