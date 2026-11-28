import type { Metadata } from "next"
import Link from "next/link"
import config from "@/config/config.json"
import { Logo } from "@sendcms/ui"
import { listDocs } from "@/lib/docs"
import { marketingUrl } from "@/lib/app-links"
import { pageOpenGraph } from "@/lib/utils"

export const metadata: Metadata = {
  title: "Documentation — SendCMS",
  description:
    "Guides and references for SendCMS — setup, the SDK, the REST API, and embedding.",
  // PRF-031/032 (Wave 11, Stream C): self-canonical + og:url.
  alternates: { canonical: "/docs" },
  openGraph: pageOpenGraph("/docs", "article"),
}

export default function DocsIndexPage() {
  const docs = listDocs()

  return (
    <div className="flex min-h-svh flex-col">
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
          Documentation
        </h1>
        <p className="mb-12 text-step--1 text-muted-foreground">
          Guides and references for SendCMS — setup, the SDK, the REST API, and
          embedding on any site.
        </p>

        <div className="space-y-6">
          {docs.map((doc) => (
            <section key={doc.slug}>
              <h2 className="mb-1 text-step-1 font-semibold">
                <Link
                  href={`/docs/${doc.slug}`}
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  {doc.title}
                </Link>
              </h2>
              <p className="text-step-0 leading-relaxed text-muted-foreground">
                {doc.description}
              </p>
            </section>
          ))}
        </div>

        <section className="mt-16 border-t pt-8">
          <h2 className="mb-1 text-step-1 font-semibold">For operators</h2>
          <p className="mb-4 text-step-0 leading-relaxed text-muted-foreground">
            Running SendCMS yourself? These repo docs are not served here — they
            live on GitHub:
          </p>
          <ul className="list-disc space-y-2 pl-5 text-step-0 leading-relaxed text-muted-foreground">
            <li>
              <a
                href="https://github.com/DashingMZA/sendcms/blob/feature/admin-control-plane/docs/operations/runbook.md"
                className="underline underline-offset-4 hover:text-foreground"
              >
                Operations runbook
              </a>{" "}
              — running SendCMS in production, incident steps, log retention.
            </li>
            <li>
              <a
                href="https://github.com/DashingMZA/sendcms/blob/feature/admin-control-plane/docs/development/monorepo.md"
                className="underline underline-offset-4 hover:text-foreground"
              >
                Monorepo guide
              </a>{" "}
              — working in the monorepo: layout, commands, dev ports,
              troubleshooting.
            </li>
            <li>
              <a
                href="https://github.com/DashingMZA/sendcms/blob/feature/admin-control-plane/docs/deployment/platforms.md"
                className="underline underline-offset-4 hover:text-foreground"
              >
                Deployment platforms
              </a>{" "}
              — Vercel, Node/Docker, Render, Netlify, Railway.
            </li>
            <li>
              <a
                href="https://github.com/DashingMZA/sendcms/blob/feature/admin-control-plane/docs/admin-control-plane/README.md"
                className="underline underline-offset-4 hover:text-foreground"
              >
                Admin control plane
              </a>{" "}
              — the admin app and its modules, architecture, authorization, and
              billing.
            </li>
          </ul>
        </section>
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
