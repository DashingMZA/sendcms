import type { BillingProvider } from "@sendcms/database"

// Billing provider registry (Admin Control Plane, Phase 8).
//
// One entry per provider, in the user-approved order: Stripe first,
// then PayPal, then Polar/Freemius, Gumroad last. The registry is the
// single source of truth for what each provider needs and what it can
// do — the env var names come from the providers' official docs (see
// research_notes/billing-providers-official-docs-20261122-0443).
// `checkoutImplemented` is false ONLY for Gumroad: it has no API to
// create a payment or a subscription, no webhook signature
// verification, and no official Node SDK, so it can be registered and
// toggled but never sells through SendCMS checkout.

export type BillingProviderId = BillingProvider

export type BillingProviderDefinition = {
  id: BillingProvider
  label: string
  // Env vars that must all be set for the provider to be "configured".
  // The admin can only enable a configured provider (enforced in the
  // service, 422 naming the missing vars).
  requiredEnvVars: string[]
  checkoutImplemented: boolean
  feeNote: string
  docsUrl: string
}

export const BILLING_PROVIDERS: readonly BillingProviderDefinition[] = [
  {
    id: "STRIPE",
    label: "Stripe",
    requiredEnvVars: [
      "STRIPE_SECRET_KEY",
      "STRIPE_PUBLISHABLE_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ],
    checkoutImplemented: true,
    feeNote: "2.9% + 30¢ per successful domestic card transaction.",
    docsUrl: "https://docs.stripe.com/billing/subscriptions",
  },
  {
    id: "PAYPAL",
    label: "PayPal",
    requiredEnvVars: [
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      "PAYPAL_WEBHOOK_ID",
    ],
    checkoutImplemented: true,
    feeNote: "PayPal Checkout 3.49% + $0.49 (US rates).",
    docsUrl: "https://developer.paypal.com/subscriptions/integrate/v6",
  },
  {
    id: "POLAR",
    label: "Polar",
    requiredEnvVars: ["POLAR_ACCESS_TOKEN", "POLAR_WEBHOOK_SECRET"],
    checkoutImplemented: true,
    feeNote: "Starter 5% + 50¢; paid plans from 3.8% + 40¢.",
    docsUrl: "https://polar.sh/docs/features/checkout/session",
  },
  {
    id: "FREEMIUS",
    label: "Freemius",
    requiredEnvVars: [
      "FREEMIUS_PRODUCT_ID",
      "FREEMIUS_API_KEY",
      "FREEMIUS_SECRET_KEY",
      "FREEMIUS_PUBLIC_KEY",
    ],
    checkoutImplemented: true,
    feeNote: "SaaS 3.8% + $0.50 per transaction, plus gateway fees.",
    docsUrl: "https://freemius.com/help/documentation/saas/app-integration/",
  },
  {
    id: "GUMROAD",
    label: "Gumroad",
    requiredEnvVars: ["GUMROAD_APP_ID", "GUMROAD_APP_SECRET"],
    checkoutImplemented: false,
    feeNote: "10% + $0.50 per transaction (30% via Discover).",
    docsUrl: "https://gumroad.com/api",
  },
] as const

export const BILLING_PROVIDER_IDS = BILLING_PROVIDERS.map((p) => p.id)

export function getBillingProviderDefinition(
  provider: BillingProvider
): BillingProviderDefinition {
  const found = BILLING_PROVIDERS.find((p) => p.id === provider)
  if (!found) throw new Error(`Unknown billing provider: ${provider}`)
  return found
}

/** Env vars that are missing (unset or blank) for a provider. */
export function missingEnvVars(
  provider: BillingProvider,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return getBillingProviderDefinition(provider).requiredEnvVars.filter(
    (name) => !env[name]?.trim()
  )
}

/** True when every required env var for the provider is set. */
export function isProviderConfigured(
  provider: BillingProvider,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return missingEnvVars(provider, env).length === 0
}
