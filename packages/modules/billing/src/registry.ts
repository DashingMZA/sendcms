import { ApiError } from "@sendcms/shared"
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
  // BIL-095: a human-readable note for providers that cannot sell
  // through SendCMS checkout (Gumroad). Surfaced on the admin
  // provider row so an admin sees WHY it is inert instead of
  // toggling it and wondering why no checkout works.
  note?: string
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
    // BIL-095: Gumroad is registered but can never sell through
    // SendCMS checkout — it has no API to create a payment or a
    // subscription and no webhook signature verification, so there
    // is no automated activation path. Manual activation only:
    // create the membership in the Gumroad dashboard, then an
    // admin assigns the plan (Admin → Subscriptions → Assign).
    // Never fake a checkout for it.
    note: "Gumroad cannot sell through SendCMS checkout (no payment-creation API, no webhook). Manual activation only: create the membership in the Gumroad dashboard, then assign the plan from Admin → Subscriptions → Assign.",
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

// ─── Stripe test/live key separation (BIL-010) ────────────────────────
// A `sk_test_…` key in production silently creates test-mode Checkout
// Sessions and Prices — customers "pay" in test mode while the webhook
// activates real subscriptions. The expected mode comes from an
// explicit `STRIPE_MODE` flag (`test` | `live`) when set, else from
// `NODE_ENV` (`production` → live, anything else → test). A webhook
// secret (`whsec_…`) carries no test/live marker in its prefix, so its
// mode cannot be checked this way — only its format is validated.

export type StripeKeyMode = "test" | "live"

export function expectedStripeMode(
  env: NodeJS.ProcessEnv = process.env
): StripeKeyMode {
  if (env.STRIPE_MODE === "live") return "live"
  if (env.STRIPE_MODE === "test") return "test"
  return env.NODE_ENV === "production" ? "live" : "test"
}

export function stripeSecretKeyMode(secretKey: string): StripeKeyMode | null {
  if (secretKey.startsWith("sk_test_")) return "test"
  if (secretKey.startsWith("sk_live_")) return "live"
  return null
}

/**
 * The mode mismatch, if the Stripe secret key's mode disagrees with
 * the deployment environment — null when they agree or the key's mode
 * cannot be determined from its prefix (an unrecognised prefix is
 * left to Stripe to reject; it is not silently treated as either
 * mode). Callers fail loudly on a non-null result.
 */
export function stripeKeyModeMismatch(env: NodeJS.ProcessEnv = process.env): {
  expected: StripeKeyMode
  actual: StripeKeyMode
  secretKeyPrefix: string
} | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? ""
  if (!secretKey) return null
  const actual = stripeSecretKeyMode(secretKey)
  if (!actual) return null
  const expected = expectedStripeMode(env)
  if (actual === expected) return null
  return {
    expected,
    actual,
    secretKeyPrefix: actual === "test" ? "sk_test_" : "sk_live_",
  }
}

/** Throws 422 when the Stripe secret key's mode mismatches the env. */
export function assertStripeKeyMode(
  env: NodeJS.ProcessEnv = process.env
): void {
  const mismatch = stripeKeyModeMismatch(env)
  if (!mismatch) return
  throw new ApiError(
    `Stripe secret key mode (${mismatch.actual}) does not match the deployment environment (${mismatch.expected}). ` +
      `A ${mismatch.secretKeyPrefix} key must not be used in a ${mismatch.expected} environment.`,
    422
  )
}
