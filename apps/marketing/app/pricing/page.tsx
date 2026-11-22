import type { Metadata } from "next"
import Link from "next/link"
import config from "@/config/config.json"
import { Logo } from "@sendcms/ui"
import { apiUrl, dashboardUrl } from "@/lib/app-links"

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Every SendCMS plan, exactly as set in the admin — prices and limits come live from the API, never hardcoded.",
}

type PublicPlan = {
  id: string
  name: string
  slug: string
  description: string | null
  version: {
    id: string
    priceAmount: number | null
    priceCurrency: string
    billingInterval: string
    trialDays: number
    entitlements: {
      forms: number | null
      domains: number | null
      submissionsPerMonth: number | null
      apiKeys: number
      aiRequestsPerDay: number | null
      mcpRequestsPerMinute: number | null
      mcpRequestsPerHour: number | null
      features: string[]
    }
  }
}

function formatPrice(plan: PublicPlan): string {
  const { priceAmount, priceCurrency, billingInterval } = plan.version
  if (priceAmount == null || priceAmount <= 0) return "Free"
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: priceCurrency,
  }).format(priceAmount / 100)
  if (billingInterval === "ANNUAL") return `${amount} / year`
  if (billingInterval === "MONTHLY") return `${amount} / month`
  return amount
}

function limitLabel(value: number | null, singular: string): string {
  if (value == null) return `Unlimited ${singular}`
  return `${value} ${singular}`
}

// Pricing — every published plan, exactly as the admin published it.
// Prices and limits come live from GET /api/public/v1/plans; nothing
// here is hardcoded. If the API is unreachable the page says so
// honestly instead of inventing prices. The homepage's
// content-driven pricing section is untouched (follow-up).
export default async function PricingPage() {
  let plans: PublicPlan[] | null = null
  try {
    const res = await fetch(`${apiUrl()}/api/public/v1/plans`, {
      cache: "no-store",
    })
    if (!res.ok) throw new Error(`Plans API returned ${res.status}`)
    plans = (await res.json()) as PublicPlan[]
  } catch {
    plans = null
  }

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4">
          <Link href="/" className="flex items-center font-semibold">
            <Logo brand={config.site} />
          </Link>
          <Link
            href="/"
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            ← Back to SendCMS
          </Link>
        </div>
      </header>

      <main
        id="main-content"
        className="mx-auto w-full max-w-5xl flex-1 px-4 py-12"
      >
        <h1 className="mb-3 text-step-4 font-bold tracking-tight">Pricing</h1>
        <p className="mb-8 leading-relaxed text-muted-foreground">
          Every plan, exactly as published — pick one and start sending.
        </p>

        {plans === null ? (
          <p className="rounded-md border p-6 text-sm text-muted-foreground">
            Pricing is unavailable right now — the plans service could not be
            reached. Please try again in a moment.
          </p>
        ) : plans.length === 0 ? (
          <p className="rounded-md border p-6 text-sm text-muted-foreground">
            No plans are published yet.
          </p>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => {
              const e = plan.version.entitlements
              const limits = [
                limitLabel(e.forms, "forms"),
                limitLabel(e.domains, "domains"),
                limitLabel(e.submissionsPerMonth, "submissions / month"),
                `${e.apiKeys} API keys`,
                limitLabel(e.aiRequestsPerDay, "AI requests / day"),
              ]
              return (
                <article
                  key={plan.id}
                  className="flex flex-col rounded-lg border p-6"
                >
                  <h2 className="text-xl font-semibold">{plan.name}</h2>
                  {plan.description && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {plan.description}
                    </p>
                  )}
                  <p className="mt-4 text-3xl font-bold">{formatPrice(plan)}</p>
                  {plan.version.trialDays > 0 && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {plan.version.trialDays}-day free trial
                    </p>
                  )}
                  <ul className="mt-6 flex flex-1 flex-col gap-2 text-sm">
                    {limits.map((limit) => (
                      <li key={limit}>✓ {limit}</li>
                    ))}
                    {e.features.map((feature) => (
                      <li key={feature}>✓ {feature}</li>
                    ))}
                  </ul>
                  <Link
                    href={`${dashboardUrl()}/dashboard/billing/checkout?planVersionId=${plan.version.id}`}
                    className="mt-6 inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
                  >
                    Get started
                  </Link>
                </article>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
