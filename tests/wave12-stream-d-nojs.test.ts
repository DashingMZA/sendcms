/**
 * @vitest-environment jsdom
 */
// Phase 16 Wave 12, Stream D (SDK-033) — the no-JS fallback's status
// snippet, taken from docs/embed-html.md itself (not a copy in this
// file), renders the ?cms_submitted=1 / ?cms_error=… params the API
// redirects with, and renders the error as plain text.
import { readFileSync } from "fs"
import { resolve } from "path"
import { describe, expect, it } from "vitest"

const embedHtml = readFileSync(
  resolve(import.meta.dirname, "../docs/embed-html.md"),
  "utf8"
)

// The documented snippet: the ```html fence that reads the params.
function documentedSnippet(): string {
  const fences = [...embedHtml.matchAll(/```html\n([\s\S]*?)```/g)].map(
    (m) => m[1]
  )
  const block = fences.find((f) => f.includes("URLSearchParams"))
  expect(block).toBeDefined()
  const js = block!.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  expect(js).toBeDefined()
  return js!
}

function runSnippet(url: string) {
  document.head.innerHTML = ""
  document.body.innerHTML = `<form data-cms-form><input name="name"></form>`
  window.history.replaceState(null, "", url)
  window.eval(documentedSnippet())
  return document.querySelector(".sc-status")
}

describe("no-JS fallback status snippet (SDK-033)", () => {
  it("renders the error param as plain text, escaped", () => {
    const banner = runSnippet(
      "/contact?cms_error=%22Message%22%20is%20required"
    )
    expect(banner).not.toBeNull()
    expect(banner!.className).toContain("sc-status--error")
    expect(banner!.textContent).toBe('"Message" is required')
  })

  it("does not execute markup smuggled in the error param", () => {
    const payload = "<script>alert(1)</script>"
    const banner = runSnippet(
      `/contact?cms_error=${encodeURIComponent(payload)}`
    )
    expect(banner!.textContent).toBe(payload)
    expect(document.querySelectorAll("script")).toHaveLength(0)
  })

  it("renders the success banner for ?cms_submitted=1", () => {
    const banner = runSnippet("/contact?cms_submitted=1")
    expect(banner).not.toBeNull()
    expect(banner!.className).toContain("sc-status--success")
    expect(banner!.textContent).toContain("Thanks!")
  })

  it("renders nothing when neither param is present", () => {
    expect(runSnippet("/contact")).toBeNull()
  })
})
