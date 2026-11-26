import type { Metadata } from "next"
import type { LucideIcon } from "lucide-react"
import Link from "next/link"
import config from "@/config/config.json"
import { resolveLink } from "@/lib/app-links"
import { Button, Card, CardContent, CardHeader, CardTitle } from "@sendcms/ui"
import { Logo } from "@sendcms/ui"
import {
  ArrowRight,
  Code2,
  CreditCard,
  Globe,
  Inbox,
  ShieldCheck,
  Sparkles,
  Terminal,
  Zap,
} from "lucide-react"

export const metadata: Metadata = {
  title: "Features — SendCMS",
  description:
    "Everything SendCMS does: contact forms on any website, verified domains, spam protection, an inbox for every submission, email notifications, AI assistance, and API access.",
}

type Feature = {
  icon: LucideIcon
  title: string
  body: string
}

// Every claim below is verified against the shipped product — see the
// per-feature sources in the repo (schema, services, and the homepage
// copy that already states the same). No unshipped feature is listed.
const FEATURES: Feature[] = [
  {
    icon: Globe,
    title: "Works on any website",
    body: "Drop one script tag into any Astro, Hugo, Next.js, WordPress, or plain HTML site. No build step required on your end, and your visitors never leave your page.",
  },
  {
    icon: ShieldCheck,
    title: "Verified domains only",
    body: "Register a domain and prove you own it with a DNS TXT record, a meta tag, or a verification file. Only your verified domains can submit to your forms — no cross-site abuse.",
  },
  {
    icon: ShieldCheck,
    title: "Spam protection built in",
    body: "Honeypot traps, spam heuristics, and optional Cloudflare Turnstile keep bots out of your inbox. Suspicious submissions are flagged, never silently dropped — and AI re-scoring can only add a spam flag, never remove one.",
  },
  {
    icon: Inbox,
    title: "An inbox for every submission",
    body: "Read, star, archive, and search submissions from one place. Tabs for unread, read, starred, archived, and spam — with bulk actions for the busy days.",
  },
  {
    icon: Zap,
    title: "Email notifications",
    body: "Get an email for every submission, delivered by Resend or your own SMTP server. If the provider is down, delivery is retried automatically with increasing delays — a submission is never lost because an email failed.",
  },
  {
    icon: Code2,
    title: "One lightweight script",
    body: "The ~10 KB SDK enhances any form in place — loading, success, and error states included — and stores nothing in your visitors' browsers. Prefer no JavaScript? Post straight to the REST API instead.",
  },
  {
    icon: Sparkles,
    title: "AI assistance, on your terms",
    body: "Optional per-form AI: suggest fields when you build a form, classify spam, summarise your inbox into a digest, and draft replies. AI is off by default, and drafts are always reviewed by you before anything is sent.",
  },
  {
    icon: Terminal,
    title: "API and MCP access",
    body: "Manage domains, forms, and submissions from your own tools: a REST API plus MCP access with 19 tools. API keys can be read-only, so integrations see exactly what they need and nothing more.",
  },
  {
    icon: CreditCard,
    title: "Plans that fit",
    body: "Start free. Paid plans are available through Stripe, PayPal, Gumroad, Freemius, or Polar — prices and limits are set in the admin and shown exactly as published on the pricing page.",
  },
]

export default function FeaturesPage() {
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
            Back to home
          </Link>
        </div>
      </header>

      <main id="main-content" className="mx-auto w-full max-w-5xl flex-1 px-4">
        <section className="py-16 text-center sm:py-24">
          <h1 className="mb-4 text-step-4 font-bold tracking-tight text-balance">
            Everything you need to collect form submissions
          </h1>
          <p className="mx-auto max-w-2xl text-step-1 leading-relaxed text-muted-foreground">
            SendCMS is a contact-form backend for any website. One script tag,
            and every submission lands in a dashboard inbox — verified,
            spam-checked, and emailed to you.
          </p>
        </section>

        <section
          aria-label="Features"
          className="grid gap-6 pb-16 sm:grid-cols-2 lg:grid-cols-3"
        >
          {FEATURES.map((feature) => {
            const Icon = feature.icon
            return (
              <Card key={feature.title}>
                <CardHeader>
                  <div className="mb-2 flex size-10 items-center justify-center rounded-md bg-primary/10">
                    <Icon className="size-5 text-primary" aria-hidden="true" />
                  </div>
                  <CardTitle className="text-step-0">{feature.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-step--1 leading-relaxed text-muted-foreground">
                    {feature.body}
                  </p>
                </CardContent>
              </Card>
            )
          })}
        </section>

        <section className="border-t py-16 text-center">
          <h2 className="mb-4 text-step-2 font-bold tracking-tight text-balance">
            Ready to collect your first submission?
          </h2>
          <p className="mx-auto mb-8 max-w-xl text-step-0 leading-relaxed text-muted-foreground">
            Create an account, verify a domain, and paste one script tag. Your
            first form is up in minutes.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Button asChild size="lg">
              <Link href={resolveLink("/sign-in")}>
                Get started
                <ArrowRight className="ml-2 size-4" aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/pricing">See pricing</Link>
            </Button>
          </div>
        </section>
      </main>

      <footer className="mt-auto border-t">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row">
          <Logo brand={config.site} />
          <p>
            <Link
              href="/"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Home
            </Link>{" "}
            ·{" "}
            <Link
              href="/features"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Features
            </Link>{" "}
            ·{" "}
            <Link
              href="/pricing"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Pricing
            </Link>{" "}
            ·{" "}
            <Link
              href="/privacy"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Privacy
            </Link>{" "}
            ·{" "}
            <Link
              href="/terms"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Terms
            </Link>{" "}
            ·{" "}
            <Link
              href="/contact"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Contact us
            </Link>
          </p>
        </div>
      </footer>
    </div>
  )
}
