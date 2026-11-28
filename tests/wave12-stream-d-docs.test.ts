// Phase 16 Wave 12, Stream D (SDK docs) — pins the doc fixes so the
// docs cannot drift from the code again without a failing test:
//   - SDK-012/SDK-027: sdk.md reset + config-precedence wording.
//   - SDK-018/SDK-025: the Origin/Referer rule + pageUrl never
//     authorizing, and getEffectiveOrigin's actual behaviour.
//   - SDK-024: every route under apps/api/app/api/public/ is named in
//     docs/rest-api.md (or explicitly declared internal); no 402.
//   - SDK-026: the 64,000-byte cap, stated exactly.
//   - SDK-028: the Turnstile 422 case + a Turnstile note in every
//     embed doc.
//   - SDK-036/SDK-038: embed-nextjs reason + 'use client' note;
//     embed-html placement / multi-form / dynamic notes.
//   - SDK-037: embed-hugo Goldmark unsafe warning.
//   - DOC-021: NEXT_PUBLIC_TURNSTILE_SITE_KEY is the dashboard's
//     build-time var (embed snippet), not the api's or the SDK's.
import { readFileSync, readdirSync } from "fs"
import { join, resolve } from "path"
import { describe, expect, it } from "vitest"
import { getEffectiveOrigin } from "../packages/api-client/src/cors"

const root = resolve(import.meta.dirname, "..")
const read = (rel: string) => readFileSync(join(root, rel), "utf8")
// Prose assertions run on whitespace-flattened text so a prettier
// re-wrap of a doc never breaks the test.
const flat = (text: string) => text.replace(/\s+/g, " ")

describe("Wave 12 Stream D — SDK docs match the code", () => {
  it("sdk.md states the reset-before-redirect order (SDK-012/SDK-027)", () => {
    const sdk = flat(read("docs/sdk.md"))
    expect(sdk).toContain("reset runs **before** any redirect")
    expect(sdk).not.toContain("Skipped when redirecting")
    expect(sdk).not.toContain("unless a redirect is configured")
    expect(sdk).toContain("only to `userId`, `formId`, and `turnstileSiteKey`")
    expect(sdk).toContain("are `init()`-only")
    expect(sdk).toContain("The redirect URL saved on the form in the dashboard")
  })

  it("sdk.md documents the 422 Turnstile case, 64,000 bytes, and the monthly-quota 429 (SDK-024/SDK-026/SDK-028)", () => {
    const sdk = read("docs/sdk.md")
    expect(sdk).toContain("no `turnstileToken` was sent")
    expect(sdk).toContain("64,000 bytes")
    expect(sdk).not.toContain("64 KB")
    expect(sdk).toContain("monthly submission quota exhausted")
    expect(sdk).toContain("There is no 402")
  })

  it("rest-api.md states the Origin/Referer rule and that pageUrl never authorizes (SDK-018/SDK-025)", () => {
    const api = flat(read("docs/rest-api.md"))
    expect(api).toContain("or the origin of the `Referer` header")
    expect(api).toContain("`pageUrl` is never an authorization signal")
    expect(api).toContain("must therefore send an `Origin`")
    expect(api).not.toContain("a missing `Origin`, and a non-HTTP origin")
    expect(api).toContain("Verification is required for this form.")
    expect(api).toContain("64,000 bytes")
    expect(api).not.toContain("64 KB")
    expect(api).toContain("There is no 402")
  })

  it("rest-api.md names every public route (SDK-024)", () => {
    const api = read("docs/rest-api.md")
    expect(api).not.toContain("single submit endpoint")
    for (const name of [
      "/api/public/v1/submit",
      "/api/public/v1/plans",
      "/api/public/v1/billing/countries",
      "/api/public/v1/billing/webhooks/{stripe,paypal,polar,freemius}",
      "/api/public/v1/unsubscribe",
    ]) {
      expect(api).toContain(name)
    }
    // Inventory check: every route file under app/api/public/ has a
    // named counterpart in the doc (the catch-all is the 404 itself).
    const publicDir = join(root, "apps/api/app/api/public/v1")
    const routes: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name === "route.ts") routes.push(path)
      }
    }
    walk(publicDir)
    expect(routes.length).toBeGreaterThan(0)
    for (const route of routes) {
      const rel = route
        .replace(publicDir, "")
        .replace("/route.ts", "")
        .replace("[...unmatched]", "")
      if (!rel) continue // the catch-all: covered by the 404 row
      if (rel.startsWith("/billing/webhooks/")) {
        // The four webhook routes are documented as one braced list.
        expect(api).toContain(
          "/billing/webhooks/{stripe,paypal,polar,freemius}"
        )
        continue
      }
      expect(api).toContain(rel)
    }
  })

  it("every embed doc mentions Turnstile (SDK-028)", () => {
    for (const doc of [
      "docs/embed-html.md",
      "docs/embed-astro.md",
      "docs/embed-nextjs.md",
      "docs/embed-hugo.md",
    ]) {
      const text = read(doc)
      expect(text).toContain("data-turnstile-site-key")
      expect(text).toContain("Verification is required for this form.")
    }
  })

  it("embed-html.md covers placement, multiple forms, and dynamic forms (SDK-038)", () => {
    const html = read("docs/embed-html.md")
    expect(html).toContain("Script placement")
    expect(html).toContain("Multiple forms")
    expect(html).toContain("Forms added later")
    expect(html).toContain("MutationObserver")
    expect(html).toContain("URLSearchParams")
  })

  it("embed-nextjs.md gives the true reason for form-level ids and the 'use client' note (SDK-036)", () => {
    const nextjs = flat(read("docs/embed-nextjs.md"))
    expect(nextjs).not.toContain("are not readable then")
    expect(nextjs).toContain("win over the script tag's")
    expect(nextjs).toContain('"use client"')
  })

  it("embed-hugo.md warns about Goldmark stripping raw HTML (SDK-037)", () => {
    const hugo = read("docs/embed-hugo.md")
    expect(hugo).toContain("unsafe = false")
    expect(hugo).toContain("unsafe = true")
    expect(hugo).toContain("silently")
  })

  it("the Turnstile site key is documented as the dashboard's build-time var (DOC-021)", () => {
    const deployment = read("docs/deployment.md")
    expect(deployment).not.toContain("baked into the SDK")
    expect(deployment).toContain(
      "injects it into the form embed snippet as `data-turnstile-site-key`"
    )
    const apiRow = deployment
      .split("\n")
      .find((line) => line.startsWith("| `sendcms` (api)"))!
    const dashboardRow = deployment
      .split("\n")
      .find((line) => line.startsWith("| `sendcms-dashboard`"))!
    expect(apiRow).not.toContain("NEXT_PUBLIC_TURNSTILE_SITE_KEY")
    expect(dashboardRow).toContain("NEXT_PUBLIC_TURNSTILE_SITE_KEY")
    expect(read("docs/operations/runbook.md")).toContain(
      "dashboard (site key, build time)"
    )
    expect(read("docs/getting-started.md")).toContain(
      "which the dashboard puts into the embed snippet"
    )
    expect(read(".env.example")).toContain("dashboard at build time")
    const compose = read("docker-compose.yml")
    const apiSection = compose.slice(
      compose.indexOf("  api:"),
      compose.indexOf("  dashboard:")
    )
    const dashboardSection = compose.slice(compose.indexOf("  dashboard:"))
    expect(apiSection).not.toContain("NEXT_PUBLIC_TURNSTILE_SITE_KEY")
    expect(dashboardSection).toContain("NEXT_PUBLIC_TURNSTILE_SITE_KEY")
  })
})

describe("getEffectiveOrigin (SDK-018/SDK-025)", () => {
  const req = (headers: Record<string, string>) =>
    new Request("https://api.sendcms.bond/api/public/v1/submit", {
      headers,
    })

  it("prefers Origin when present", () => {
    expect(
      getEffectiveOrigin(
        req({
          Origin: "https://example.com",
          Referer: "https://other.example/page",
        })
      )
    ).toBe("https://example.com")
  })

  it("falls back to the Referer origin when Origin is absent", () => {
    expect(
      getEffectiveOrigin(req({ Referer: "https://example.com/contact" }))
    ).toBe("https://example.com")
  })

  it("returns null when neither header is present", () => {
    expect(getEffectiveOrigin(req({}))).toBeNull()
  })

  it("returns null for an unparseable Referer", () => {
    expect(getEffectiveOrigin(req({ Referer: "not a url" }))).toBeNull()
  })
})
