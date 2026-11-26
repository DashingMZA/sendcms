import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { PageHeader } from "@/components/dashboard/page-header"
import { PageContent } from "@/components/dashboard/page-content"
import { countryFromHeaders } from "@sendcms/billing"
import {
  DASHBOARD_BILLING_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { CheckoutManager } from "./checkout-manager"

// The customer's checkout page (Phase 8) — a proper page, not a
// popup. The server detects the customer's country from the request
// geo headers (Vercel/Cloudflare); with no header (local dev) the
// customer picks the country on the page instead.
export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ planVersionId?: string; cancelled?: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/sign-in")

  const locale = await getRequestLocale(session.user.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_BILLING_DOMAINS)
  const t = await getTranslator(locale, "billing")
  const params = await searchParams
  const detectedCountry = countryFromHeaders(await headers())

  return (
    <div>
      <PageHeader
        title={t("checkoutTitle")}
        description={t("checkoutDescription")}
      />

      <PageContent>
        <TranslationProvider dictionaries={dictionaries}>
          <CheckoutManager
            locale={locale}
            detectedCountry={detectedCountry}
            initialPlanVersionId={params.planVersionId ?? null}
            cancelled={params.cancelled === "1"}
          />
        </TranslationProvider>
      </PageContent>
    </div>
  )
}
