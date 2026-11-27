import type { Metadata } from "next"
import Link from "next/link"
import config from "@/config/config.json"
import { Logo } from "@sendcms/ui"
import { getListPage } from "@sendcms/content"
import { pageOpenGraph } from "@/lib/utils"

export const metadata: Metadata = {
  title: "Privacy Policy — SendCMS",
  description:
    "What data SendCMS collects, why, and what happens to it — in plain language.",
  // PRF-031/032 (Wave 11, Stream C): self-canonical + og:url.
  alternates: { canonical: "/privacy" },
  openGraph: pageOpenGraph("/privacy"),
}

type PrivacySection = {
  title: string
  body: string[]
}

export default function PrivacyPage() {
  const { frontmatter } = getListPage("privacy.md")
  const { title, lastUpdated, sections } = frontmatter as {
    title: string
    lastUpdated: string
    sections: PrivacySection[]
  }

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-3xl items-center px-4">
          <Link href="/" className="flex items-center font-semibold">
            <Logo brand={config.site} />
          </Link>
        </div>
      </header>

      <main
        id="main-content"
        className="mx-auto w-full max-w-3xl flex-1 px-4 py-16"
      >
        <h1 className="mb-2 text-step-3 font-bold tracking-tight text-balance">
          {title}
        </h1>
        <p className="mb-4 text-step--1 text-muted-foreground">{lastUpdated}</p>

        <div className="space-y-10">
          {sections.map((section) => (
            <section key={section.title}>
              <h2 className="mb-3 text-step-1 font-semibold">
                {section.title}
              </h2>
              {section.body.map((paragraph) => (
                <p
                  key={paragraph}
                  className="text-step-0 leading-relaxed text-muted-foreground"
                >
                  {paragraph}
                </p>
              ))}
            </section>
          ))}
        </div>

        <p className="mt-12 text-step--1 leading-relaxed text-muted-foreground">
          Questions about this policy?{" "}
          <Link
            href="/contact"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Contact us
          </Link>
          .
        </p>
      </main>

      <footer className="mt-auto border-t">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-8 text-sm text-muted-foreground">
          <Logo brand={config.site} />
          <Link
            href="/"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Back to home
          </Link>
        </div>
      </footer>
    </div>
  )
}
