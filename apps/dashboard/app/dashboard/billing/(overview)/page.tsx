import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { PageHeader } from "@/components/dashboard/page-header"
import { PageContent } from "@/components/dashboard/page-content"
import {
  DASHBOARD_BILLING_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { getMySubscription, verifyCheckoutReturn } from "@sendcms/billing"
import { BillingOverview } from "../billing-overview"

// The customer's billing page (Phase 8): the current subscription
// and a link to change plans. SRC-110: the server fetches the
// subscription and passes it as initialData, so the plan renders in
// the SSR HTML instead of after the client fetch. A successful
// provider checkout lands back here with ?checkout=success.
//
// BIL-015 / BIL-016: the success note is shown ONLY when the
// return is verified against the provider — the bare
// `checkout=success` param used to show it for any visit, paid or
// not. Stripe returns `session_id`, PayPal `subscription_id` (or
// `token` for one-time orders); Polar/Freemius return no id, so
// their returns keep the old "will be active shortly" note (the
// webhook is the only signal there). A paid-but-not-yet-activated
// return shows the pending note instead of a false success.
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{
    checkout?: string
    provider?: string
    session_id?: string
    subscription_id?: string
    token?: string
  }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/sign-in")

  const subscription = await getMySubscription(session.user.id)

  const locale = await getRequestLocale(session.user.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_BILLING_DOMAINS)
  const t = await getTranslator(locale, "billing")
  const params = await searchParams
  let checkoutSuccess = false
  let checkoutPending = false
  if (params.checkout === "success") {
    const provider = params.provider?.toLowerCase()
    if (provider === "stripe" || provider === "paypal") {
      const checkoutId =
        provider === "stripe"
          ? params.session_id
          : (params.subscription_id ?? params.token)
      if (checkoutId) {
        try {
          const verification = await verifyCheckoutReturn(
            session.user.id,
            provider === "stripe" ? "STRIPE" : "PAYPAL",
            checkoutId
          )
          checkoutSuccess = verification.verified
          checkoutPending = verification.pending
        } catch {
          // Verification is best-effort: a provider outage must
          // not break the billing page — no note, and the
          // subscription appears once the webhook lands.
        }
      }
    } else {
      // Polar / Freemius (or no provider): no checkout id to
      // verify against — the old note stands.
      checkoutSuccess = true
    }
  }

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />

      <PageContent>
        <TranslationProvider dictionaries={dictionaries}>
          <BillingOverview
            locale={locale}
            checkoutSuccess={checkoutSuccess}
            checkoutPending={checkoutPending}
            initialSubscription={subscription}
          />
        </TranslationProvider>
      </PageContent>
    </div>
  )
}
