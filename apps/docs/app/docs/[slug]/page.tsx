import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import config from "@/config/config.json"
import { Logo } from "@sendcms/ui"
import { markdownify } from "@sendcms/content"
import { DOC_SLUGS, getDoc, isDocSlug } from "@/lib/docs"
import { marketingUrl } from "@/lib/app-links"

export function generateStaticParams() {
  return DOC_SLUGS.map((slug) => ({ slug }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  if (!isDocSlug(slug)) return { title: "Not found — SendCMS" }
  const doc = getDoc(slug)
  return {
    title: `${doc.title} — SendCMS`,
    description: doc.description,
  }
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  if (!isDocSlug(slug)) notFound()
  const doc = getDoc(slug)

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-4">
          <Link
            href={marketingUrl()}
            className="flex items-center font-semibold"
          >
            <Logo brand={config.site} />
          </Link>
          <Link
            href="/docs"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            All docs
          </Link>
        </div>
      </header>

      <main
        id="main-content"
        className="mx-auto w-full max-w-3xl flex-1 px-4 py-16"
      >
        <h1 className="mb-8 text-step-3 font-bold tracking-tight text-balance">
          {doc.title}
        </h1>
        {/* The docs are written as plain markdown (no frontmatter). The
            first H1 is the title above; the body is rendered as HTML. */}
        <div
          className="prose max-w-none text-step-0 leading-relaxed text-muted-foreground [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-sm [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-step-1 [&_h2]:font-semibold [&_h2]:text-foreground [&_h3]:mt-8 [&_h3]:mb-2 [&_h3]:text-step-0 [&_h3]:font-semibold [&_h3]:text-foreground [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_p]:mb-4 [&_pre]:mb-4 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:bg-card [&_pre]:p-4 [&_pre]:text-sm [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5"
          dangerouslySetInnerHTML={markdownify(doc.body)}
        />
      </main>

      <footer className="mt-auto border-t">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-8 text-sm text-muted-foreground">
          <Logo brand={config.site} />
          <Link
            href="/docs"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Back to all docs
          </Link>
        </div>
      </footer>
    </div>
  )
}
