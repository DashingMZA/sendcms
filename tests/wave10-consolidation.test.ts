// Wave 10 consolidation — regression tests for fixes made during
// consolidation (not by any single stream). No test hits the network
// or the DB. React is rendered without JSX (vitest only includes
// *.test.ts) via renderToStaticMarkup.
import { describe, expect, it } from "vitest"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import * as fs from "node:fs"
import * as path from "node:path"
import { ChartStyle } from "@/packages/ui/src/components/chart"
import { buildEmbedSnippet } from "@/packages/sdk/src/snippet"

const repoRoot = path.resolve(__dirname, "..")

describe("ChartStyle SSR (Wave 10 consolidation — CSS.escape ReferenceError)", () => {
  it("renders with no CSS global (the Node/SSR path) — no throw", () => {
    // The admin overview SSR crashed here: `CSS` is a browser-only
    // global, undefined during server rendering.
    expect(typeof CSS).toBe("undefined")
    const markup = renderToStaticMarkup(
      React.createElement(ChartStyle, {
        id: "overview-chart",
        config: {
          submissions: { label: "Submissions", color: "var(--chart-1)" },
        },
      })
    )
    expect(markup).toContain('[data-chart="overview-chart"]')
    expect(markup).toContain("--color-submissions: var(--chart-1);")
  })

  it("falls back to backslash escaping for an id with CSS metacharacters", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ChartStyle, {
        id: "x] {} evil",
        config: { good: { label: "Good", color: "var(--chart-1)" } },
      })
    )
    expect(markup).not.toContain("[data-chart=x]")
    expect(markup).toContain("[data-chart=")
  })
})

describe("buildEmbedSnippet escaping (SRC-328(c) follow-up)", () => {
  const hostileForm = {
    id: "cmform1",
    ownerId: "owner1",
    turnstileEnabled: false,
    fields: [
      {
        name: 'name" onfocus="alert(1)',
        label: "Name <script>alert(1)</script>",
        type: "TEXT",
        required: true,
        placeholder: 'Say "hi"',
        options: [],
      },
      {
        name: "choice",
        label: "Choice",
        type: "SELECT",
        required: false,
        options: ['a"b', "c<d>"],
      },
    ],
  }

  it("escapes field names inside name= attributes", () => {
    const snippet = buildEmbedSnippet("https://api.example.com", hostileForm)
    expect(snippet).not.toContain('name="name" onfocus="alert(1)"')
    expect(snippet).toContain('name="name&quot; onfocus=&quot;alert(1)"')
  })

  it("escapes label/option text content (< and >)", () => {
    const snippet = buildEmbedSnippet("https://api.example.com", hostileForm)
    expect(snippet).not.toContain("<script>alert(1)</script>")
    expect(snippet).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(snippet).not.toContain(">c<d></option>")
    expect(snippet).toContain("c&lt;d&gt;")
  })
})

describe("design-tokens parity (UX-203 consolidation)", () => {
  it("all five apps carry the warning/success tokens", () => {
    for (const app of ["admin", "dashboard", "docs", "marketing", "updates"]) {
      const css = fs.readFileSync(
        path.join(repoRoot, "apps", app, "styles", "design-tokens.css"),
        "utf8"
      )
      for (const token of [
        "--warning:",
        "--warning-foreground:",
        "--success:",
        "--success-foreground:",
        "--color-warning:",
        "--color-success:",
      ]) {
        expect(css, `${app} missing ${token}`).toContain(token)
      }
    }
  })
})

describe("scroll-area radius (UX-205 consolidation)", () => {
  it("uses a documented scale radius, no arbitrary rounded-[...]", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "packages/ui/src/components/scroll-area.tsx"),
      "utf8"
    )
    expect(src).not.toMatch(/rounded-\[/)
    expect(src).toContain("rounded-lg")
  })
})
