// Wave 11, Stream C — SEO / docs regression tests (PRF-031/032/033/
// 035/036/037/038/039, DOC-051, PRF-017).
//
// Two kinds of assertions here, matching how this repo already tests
// wiring (cf. the seven-pages "static file read" blocks):
//   1. Unit tests on the pure helpers — parseDoc / stripInlineMarkdown
//      / truncateAtSentence, getDoc / getDocLastModified (docs lib),
//      lastModifiedForMarketingPage, latestChangelogDate.
//   2. Static source assertions for the Next.js metadata itself — the
//      layout/page modules import `@/lib/*`, which vitest cannot
//      resolve to the public apps, so the rendered <head> is verified
//      by the production-build HTTP probes in the Stream C report
//      (canonical / og:* / twitter:* / JSON-LD / robots / sitemap /
//      demo 301), not by importing the pages here.
//
// TIME: no test asserts a locale-rendered clock time. lastmod
// assertions compare instants (ISO strings / getTime), never rendered
// dates.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  DOC_SLUGS,
  getDoc,
  getDocLastModified,
  listDocs,
  parseDoc,
  stripInlineMarkdown,
  truncateAtSentence,
} from "../apps/docs/lib/docs"
import { lastModifiedForMarketingPage } from "../apps/marketing/lib/sitemap-lastmod"
import { latestChangelogDate } from "../apps/updates/lib/changelog"

const repoRoot = process.cwd()
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf-8")

// The docs lib resolves the repo's docs/ dir from process.cwd()
// (apps/docs); the marketing helper resolves its content files the
// same way (apps/marketing); the changelog helper likewise
// (apps/updates). Each describe chdirs to its app and restores the
// repo root afterwards — this file runs in its own vitest worker.
describe("PRF-033 — parseDoc: first paragraph, not first line", () => {
  beforeAll(() => {
    process.chdir(path.join(repoRoot, "apps/docs"))
  })
  afterAll(() => {
    process.chdir(repoRoot)
  })

  it("joins a wrapped first paragraph across lines", () => {
    const { description } = parseDoc(
      [
        "# Embed in HTML",
        "",
        "No framework, no build step. Works on any static site",
        "or WordPress page — paste one script tag and a normal form.",
        "",
        "```mermaid",
        "flowchart LR",
        "```",
      ].join("\n")
    )
    expect(description).toContain("No framework, no build step.")
    expect(description).toContain(
      "Works on any static site or WordPress page — paste one script tag and a normal form."
    )
    expect(description).not.toContain("```")
    expect(description).not.toContain("mermaid")
  })

  it("strips inline Markdown: code spans (incl. `<form>`), links, emphasis", () => {
    expect(
      stripInlineMarkdown(
        "Turns any `<form>` into a [SendCMS form](https://sendcms.bond) with **spam** checks."
      )
    ).toBe("Turns any form into a SendCMS form with spam checks.")
    const { description } = parseDoc(
      [
        "# SendCMS JavaScript SDK",
        "",
        "A dependency-free vanilla-TS snippet (10 KB minified) that turns any",
        "`<form>` into a SendCMS form. It posts to the public submission API.",
      ].join("\n")
    )
    expect(description).toContain("turns any form into a SendCMS form.")
    expect(description).not.toContain("`")
    expect(description).not.toContain("<form>")
  })

  it("truncates at a sentence boundary at or under ~155 chars", () => {
    const long =
      "The first sentence is long enough to keep whole. " +
      "Second sentence keeps going with detail after detail after detail " +
      "after detail after detail after detail after detail after detail."
    const truncated = truncateAtSentence(long)
    expect(truncated.length).toBeLessThanOrEqual(155)
    expect(truncated).toBe("The first sentence is long enough to keep whole.")
    // No sentence boundary at all: cut at a word boundary with an ellipsis.
    const noBoundary = truncateAtSentence("word ".repeat(60).trim())
    expect(noBoundary.length).toBeLessThanOrEqual(156)
    expect(noBoundary.endsWith("…")).toBe(true)
  })

  it("the derived rest-api description still carries the YOUR_APP placeholder (hence the override)", () => {
    const { description } = parseDoc(
      [
        "# REST API",
        "",
        "Base URL: `https://YOUR_APP` (your SendCMS deployment — in production,",
        "the api app, e.g. `https://api.sendcms.bond`). There is no API",
        "version in the path beyond `/v1/`.",
      ].join("\n")
    )
    expect(description).toContain("YOUR_APP")
    // …while the served description drops it entirely (frontmatter override).
    expect(getDoc("rest-api").description).not.toContain("YOUR_APP")
    expect(getDoc("rest-api").description).not.toContain("`")
  })

  it("every served doc description is a complete sentence, 100–155 chars, no backticks or placeholders", () => {
    for (const doc of listDocs()) {
      expect(
        doc.description.length,
        `${doc.slug} description length`
      ).toBeGreaterThanOrEqual(100)
      expect(
        doc.description.length,
        `${doc.slug} description length`
      ).toBeLessThanOrEqual(155)
      expect(doc.description).not.toContain("`")
      expect(doc.description).not.toContain("YOUR_APP")
      expect(doc.description.endsWith(".")).toBe(true)
    }
    expect(listDocs()).toHaveLength(12)
    expect(DOC_SLUGS).toHaveLength(12)
  })
})

describe("PRF-038 — sitemap lastmod is per-URL content time", () => {
  beforeAll(() => {
    process.chdir(path.join(repoRoot, "apps/docs"))
  })
  afterAll(() => {
    process.chdir(repoRoot)
  })

  it("a doc's lastmod equals its last commit time", () => {
    const expected = execFileSync(
      "git",
      ["log", "-1", "--format=%cI", "--", "docs/rest-api.md"],
      { cwd: repoRoot, encoding: "utf-8" }
    ).trim()
    expect(getDocLastModified("rest-api").toISOString()).toBe(
      new Date(expected).toISOString()
    )
    expect(getDocLastModified("rest-api").getTime()).toBeLessThanOrEqual(
      Date.now()
    )
  })

  it("marketing lastmod comes from the page's source file mtime", () => {
    process.chdir(path.join(repoRoot, "apps/marketing"))
    try {
      const terms = lastModifiedForMarketingPage("/terms")
      expect(terms.getTime()).toBeLessThanOrEqual(Date.now())
      expect(terms.getTime()).toBeGreaterThan(0)
      // An unknown route falls back to build time instead of throwing.
      expect(
        lastModifiedForMarketingPage("/nope").getTime()
      ).toBeLessThanOrEqual(Date.now())
    } finally {
      process.chdir(path.join(repoRoot, "apps/docs"))
    }
  })

  it("changelog lastmod is the latest entry's date", () => {
    process.chdir(path.join(repoRoot, "apps/updates"))
    try {
      // The newest entry in apps/updates/content/changelog.md.
      // Assert the local calendar date, not the UTC ISO string:
      // `new Date("November 18, 2026")` is local midnight, which is
      // 2026-11-17T19:00Z in UTC+5 — the old startsWith("2026-11-18")
      // assertion failed in PKT while passing in UTC (TZ-dependent).
      const latest = latestChangelogDate()
      expect(latest.getFullYear()).toBe(2026)
      expect(latest.getMonth()).toBe(10) // November
      expect(latest.getDate()).toBe(18)
    } finally {
      process.chdir(path.join(repoRoot, "apps/docs"))
    }
  })
})

describe("PRF-031/032/035/036/037/039 — metadata wiring (static source)", () => {
  it("all three public layouts set metadataBase + shared OG/Twitter defaults", () => {
    for (const layout of [
      "apps/marketing/app/layout.tsx",
      "apps/docs/app/layout.tsx",
      "apps/updates/app/layout.tsx",
    ]) {
      const src = read(layout)
      expect(src, layout).toContain("const baseUrl = getBaseUrl()")
      expect(src, layout).toContain("metadataBase: new URL(baseUrl)")
      expect(src, layout).toContain('siteName: "SendCMS"')
      expect(src, layout).toContain('locale: "en_US"')
      expect(src, layout).toContain('type: "website"')
      expect(src, layout).toContain('card: "summary_large_image"')
      // The og:image is absolute (base URL + config path), never the
      // bare relative config value on its own.
      expect(src, layout).toContain("`${baseUrl}${config.metadata.meta_image}`")
    }
    // No twitter:site/creator is SET anywhere: SendCMS has no X handle
    // in the repo — the finding says "where sensible", and inventing
    // one is not. (The words appear in the layout's own comment
    // explaining the omission; the regex below targets the twitter
    // metadata block, not the comment.)
    for (const layout of [
      "apps/marketing/app/layout.tsx",
      "apps/docs/app/layout.tsx",
      "apps/updates/app/layout.tsx",
    ]) {
      const src = read(layout)
      expect(src, layout).not.toMatch(/twitter:\s*\{[^}]*\bsite:/)
      expect(src, layout).not.toMatch(/twitter:\s*\{[^}]*\bcreator:/)
    }
  })

  it("every public page sets its own self-canonical + og:url", () => {
    const cases: [string, string][] = [
      ["apps/marketing/app/page.tsx", 'canonical: "/"'],
      ["apps/marketing/app/features/page.tsx", 'canonical: "/features"'],
      ["apps/marketing/app/pricing/page.tsx", 'canonical: "/pricing"'],
      ["apps/marketing/app/contact/page.tsx", 'canonical: "/contact"'],
      ["apps/marketing/app/terms/page.tsx", 'canonical: "/terms"'],
      ["apps/marketing/app/privacy/page.tsx", 'canonical: "/privacy"'],
      [
        "apps/marketing/app/demo/contact-us/page.tsx",
        'canonical: "/demo/contact-us"',
      ],
      ["apps/docs/app/docs/page.tsx", 'canonical: "/docs"'],
      ["apps/docs/app/docs/[slug]/page.tsx", "canonical: `/docs/${slug}`"],
      ["apps/updates/app/changelog/page.tsx", 'canonical: "/changelog"'],
    ]
    for (const [file, canonical] of cases) {
      expect(read(file), file).toContain(canonical)
      expect(read(file), file).toContain("openGraph")
    }
    // Docs/changelog pages are articles, not generic websites.
    expect(read("apps/docs/app/docs/[slug]/page.tsx")).toContain(
      'pageOpenGraph(`/docs/${slug}`, "article")'
    )
    expect(read("apps/updates/app/changelog/page.tsx")).toContain(
      'pageOpenGraph("/changelog", "article")'
    )
    // 404s deliberately carry NO canonical (PRF-031: leave them without
    // one, explicitly).
    for (const notFound of [
      "apps/marketing/app/not-found.tsx",
      "apps/docs/app/not-found.tsx",
      "apps/updates/app/not-found.tsx",
    ]) {
      expect(read(notFound), notFound).not.toContain("canonical")
    }
  })

  it("the homepage completes its OG block (og:url, og:type)", () => {
    const src = read("apps/marketing/app/page.tsx")
    expect(src).toContain('pageOpenGraph("/", "website")')
  })

  it("PRF-032: every per-page openGraph goes through pageOpenGraph", () => {
    // A page's openGraph REPLACES the layout's wholesale (Next.js does
    // not merge them), so a bare { url } would silently drop og:image,
    // og:site_name and og:locale from the rendered <head> — caught by
    // the live probes 2026-11-27. The helper repeats the shared fields.
    for (const utils of [
      "apps/marketing/lib/utils.ts",
      "apps/docs/lib/utils.ts",
      "apps/updates/lib/utils.ts",
    ]) {
      const src = read(utils)
      expect(src, utils).toContain("export function pageOpenGraph")
      expect(src, utils).toContain('siteName: "SendCMS"')
      expect(src, utils).toContain('locale: "en_US"')
      expect(src, utils).toContain("`${baseUrl}${config.metadata.meta_image}`")
    }
    for (const file of [
      "apps/marketing/app/page.tsx",
      "apps/marketing/app/features/page.tsx",
      "apps/marketing/app/pricing/page.tsx",
      "apps/marketing/app/contact/page.tsx",
      "apps/marketing/app/terms/page.tsx",
      "apps/marketing/app/privacy/page.tsx",
      "apps/marketing/app/demo/contact-us/page.tsx",
      "apps/docs/app/docs/page.tsx",
      "apps/docs/app/docs/[slug]/page.tsx",
      "apps/updates/app/changelog/page.tsx",
    ]) {
      const src = read(file)
      expect(src, file).toContain("pageOpenGraph(")
      // No bare openGraph object literal left behind — every page's
      // openGraph must come from the helper.
      expect(src, file).not.toMatch(/openGraph:\s*\{[^}]*url:/)
    }
  })

  it("PRF-037: pricing/contact titles carry the brand suffix; terms/changelog descriptions are full sentences", () => {
    expect(read("apps/marketing/app/pricing/page.tsx")).toContain(
      '"Pricing — SendCMS"'
    )
    expect(read("apps/marketing/app/contact/page.tsx")).toContain(
      '"Contact us — SendCMS"'
    )
    const terms = read("apps/marketing/app/terms/page.tsx")
    expect(terms).toContain("The terms that govern your use of SendCMS")
    const changelog = read("apps/updates/app/changelog/page.tsx")
    expect(changelog).toContain("What's new in SendCMS, newest first")
  })

  it("PRF-035: exactly one demo URL — the static copy is gone, the route 301s it, the route has its own metadata", () => {
    expect(
      existsSync(
        path.join(repoRoot, "apps/marketing/public/demo/contact-us.html")
      )
    ).toBe(false)
    const nextConfig = read("apps/marketing/next.config.mjs")
    expect(nextConfig).toContain('source: "/demo/contact-us.html"')
    expect(nextConfig).toContain('destination: "/demo/contact-us"')
    expect(nextConfig).toContain("permanent: true")
    const demoPage = read("apps/marketing/app/demo/contact-us/page.tsx")
    expect(demoPage).toContain('"Live demo — SendCMS"')
    // The page is a server component now: no "use client" directive
    // (the words still appear in a comment explaining the split).
    expect(demoPage.startsWith('"use client"')).toBe(false)
    expect(demoPage).toContain('from "./demo-form"')
    const demoForm = read("apps/marketing/app/demo/contact-us/demo-form.tsx")
    expect(demoForm).toContain('"use client"')
    // The survivor is in the sitemap and linked from the homepage nav.
    expect(read("apps/marketing/app/sitemap.ts")).toContain("/demo/contact-us")
    expect(read("apps/marketing/app/page.tsx")).toContain(
      'href="/demo/contact-us"'
    )
  })

  it("PRF-036: JSON-LD types exist per surface", () => {
    expect(read("apps/marketing/app/layout.tsx")).toContain("SiteSchema")
    expect(read("apps/marketing/components/site-schema.tsx")).toContain(
      '"WebSite"'
    )
    expect(read("apps/marketing/components/site-schema.tsx")).toContain(
      '"Organization"'
    )
    expect(read("apps/docs/app/docs/[slug]/page.tsx")).toContain(
      '"TechArticle"'
    )
    expect(read("apps/docs/app/docs/[slug]/page.tsx")).toContain(
      '"BreadcrumbList"'
    )
    expect(read("apps/updates/app/changelog/page.tsx")).toContain(
      '"BlogPosting"'
    )
  })

  it("PRF-039: robots Host is a bare hostname, and the sitemap line is still absolute", () => {
    for (const robots of [
      "apps/marketing/app/robots.ts",
      "apps/docs/app/robots.ts",
      "apps/updates/app/robots.ts",
    ]) {
      const src = read(robots)
      expect(src, robots).toContain("host: new URL(baseUrl).hostname")
      expect(src, robots).not.toContain("host: baseUrl,")
      expect(src, robots).toContain("sitemap: `${baseUrl}/sitemap.xml`")
    }
  })

  it("PRF-038: no sitemap still uses one shared build-time lastmod", () => {
    for (const sitemap of [
      "apps/marketing/app/sitemap.ts",
      "apps/docs/app/sitemap.ts",
      "apps/updates/app/sitemap.ts",
    ]) {
      expect(read(sitemap), sitemap).not.toContain(
        "const lastModified = new Date()"
      )
    }
    expect(read("apps/docs/app/sitemap.ts")).toContain("getDocLastModified")
    expect(read("apps/updates/app/sitemap.ts")).toContain("latestChangelogDate")
    expect(read("apps/marketing/app/sitemap.ts")).toContain(
      "lastModifiedForMarketingPage"
    )
  })

  it("DOC-051 + PRF-017: the runbook has Incidents and per-tier failover with RTO/RPO", () => {
    const runbook = read("docs/operations/runbook.md")
    expect(runbook).toContain("## Incidents")
    expect(runbook).toContain("SEV-1")
    expect(runbook).toContain("Support response times")
    expect(runbook).toContain("best effort")
    expect(runbook).toContain("Escalation path")
    expect(runbook).toContain("Failover, per tier")
    expect(runbook).toContain("RTO")
    expect(runbook).toContain("RPO")
    expect(runbook).toContain("accepted risk")
  })
})
