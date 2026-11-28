// Content loader + markdown sanitiser (SRC-317 / SEC-208).
import { afterAll, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
// `@sendcms/content` is not linked at the repo root (no root package
// depends on it), so this test imports it by relative path.
import { getListPage, markdownify } from "../packages/content/src/index"

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sendcms-content-"))
const contentDir = path.join(tmpRoot, "content")
fs.mkdirSync(path.join(contentDir, "sub"), { recursive: true })
fs.writeFileSync(
  path.join(contentDir, "sub", "ok.md"),
  "---\ntitle: Ok\n---\n# Hi\n"
)
fs.writeFileSync(path.join(tmpRoot, "secret.txt"), "top-secret")

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe("getListPage (SRC-317)", () => {
  it("reads a nested file inside the content dir", () => {
    const page = getListPage("sub/ok.md", contentDir)
    expect(page.frontmatter).toEqual({ title: "Ok" })
    expect(page.content).toContain("# Hi")
  })

  it("refuses a path that escapes the content dir", () => {
    expect(() => getListPage("../secret.txt", contentDir)).toThrow(
      /escapes the content directory/
    )
    expect(() => getListPage("../../secret.txt", contentDir)).toThrow(
      /escapes the content directory/
    )
  })

  it("refuses an absolute file path", () => {
    expect(() =>
      getListPage(path.join(tmpRoot, "secret.txt"), contentDir)
    ).toThrow(/absolute content path/)
  })
})

describe("markdownify (SEC-208 / SRC-317)", () => {
  it("strips script tags and event-handler attributes", () => {
    const { __html } = markdownify(
      '<img src="x" onerror="alert(1)">\n\n<script>alert(1)</script>\n\nhello'
    )
    expect(__html).not.toContain("onerror")
    expect(__html).not.toContain("<script")
    expect(__html).not.toContain("<img")
    expect(__html).toContain("hello")
  })

  it("neutralises javascript: link targets", () => {
    const { __html } = markdownify("[click me](javascript:alert(1))")
    expect(__html).not.toContain("javascript:")
    expect(__html).toContain('href="#"')
  })

  it("keeps https links and normal markdown rendering", () => {
    const { __html } = markdownify(
      "[docs](https://example.com/docs) and **bold**"
    )
    expect(__html).toContain('href="https://example.com/docs"')
    expect(__html).toContain("<strong>bold</strong>")
  })

  it("strips raw HTML in inline mode too", () => {
    const { __html } = markdownify(
      'Hello <b onmouseover="x()">world</b>',
      false
    )
    expect(__html).not.toContain("onmouseover")
    expect(__html).not.toContain("<b")
    expect(__html).toContain("Hello")
    expect(__html).toContain("world")
  })
})

describe("markdownify .md link rewriting (LVE-003)", () => {
  it("rewrites a served doc slug to its extensionless /docs route", () => {
    const { __html } = markdownify("[SDK](sdk.md)")
    expect(__html).toContain('href="/docs/sdk"')
    expect(__html).not.toContain(".md")
  })

  it("rewrites ./-prefixed and anchored .md links to the same route", () => {
    const { __html } = markdownify(
      "[REST API](./rest-api.md) and [install](sdk.md#install)"
    )
    expect(__html).toContain('href="/docs/rest-api"')
    expect(__html).toContain('href="/docs/sdk#install"')
  })

  it("links a doc with no live page to its GitHub source instead of a 404", () => {
    const { __html } = markdownify(
      "[platforms](deployment/platforms.md) and [runbook](operations/runbook.md)"
    )
    expect(__html).toContain(
      'href="https://github.com/DashingMZA/sendcms/blob/feature/admin-control-plane/docs/deployment/platforms.md"'
    )
    expect(__html).toContain(
      'href="https://github.com/DashingMZA/sendcms/blob/feature/admin-control-plane/docs/operations/runbook.md"'
    )
  })

  it("links a flat repo-only doc (architecture.md) to GitHub, not /docs", () => {
    const { __html } = markdownify("[arch](architecture.md)")
    expect(__html).toContain(
      'href="https://github.com/DashingMZA/sendcms/blob/feature/admin-control-plane/docs/architecture.md"'
    )
    expect(__html).not.toContain('href="/docs/architecture"')
  })

  it("leaves absolute .md URLs untouched", () => {
    const { __html } = markdownify("[guide](https://example.com/guide.md)")
    expect(__html).toContain('href="https://example.com/guide.md"')
  })
})
