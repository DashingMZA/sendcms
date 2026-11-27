import type { Metadata } from "next"
import Link from "next/link"
import config from "@/config/config.json"
import { Logo } from "@sendcms/ui"
import { getListPage } from "@sendcms/content"
import { marketingUrl } from "@/lib/app-links"
import { getBaseUrl, pageOpenGraph } from "@/lib/utils"

export const metadata: Metadata = {
  title: "Changelog — SendCMS",
  description:
    "What's new in SendCMS, newest first — every release, feature, and fix, with the date it shipped and a note on what changed.",
  // PRF-031/032 (Wave 11, Stream C): self-canonical + article OG.
  alternates: { canonical: "/changelog" },
  openGraph: pageOpenGraph("/changelog", "article"),
}

type ChangelogEntry = {
  version: string
  date: string
  changes: string[]
}

export default function ChangelogPage() {
  const { frontmatter } = getListPage("changelog.md")
  const { title, subtitle, entries } = frontmatter as {
    title: string
    subtitle: string
    entries: ChangelogEntry[]
  }
  const baseUrl = getBaseUrl()

  // PRF-036 (Wave 11, Stream C): one BlogPosting per changelog entry
  // (same pattern as ProductSchema).
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": entries.map((entry) => ({
      "@type": "BlogPosting",
      headline: `SendCMS v${entry.version}`,
      description: entry.changes[0] ?? subtitle,
      url: `${baseUrl}/changelog`,
      datePublished: new Date(entry.date).toISOString(),
      author: { "@type": "Organization", name: "SendCMS", url: baseUrl },
    })),
  }

  return (
    <div className="flex min-h-svh flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-3xl items-center px-4">
          <Link
            href={marketingUrl()}
            className="flex items-center font-semibold"
          >
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
        <p className="mb-12 text-step--1 text-muted-foreground">{subtitle}</p>

        <div className="space-y-12">
          {entries.map((entry) => (
            <section key={entry.version}>
              <div className="mb-4 flex items-baseline gap-3">
                <h2 className="text-step-2 font-semibold">v{entry.version}</h2>
                <span className="text-step--1 text-muted-foreground">
                  {entry.date}
                </span>
              </div>
              <ul className="list-disc space-y-2 pl-5 text-step-0 leading-relaxed text-muted-foreground">
                {entry.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </main>

      <footer className="mt-auto border-t">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-8 text-sm text-muted-foreground">
          <Logo brand={config.site} />
          <Link
            href={marketingUrl()}
            className="underline underline-offset-4 hover:text-foreground"
          >
            Back to home
          </Link>
        </div>
      </footer>
    </div>
  )
}
