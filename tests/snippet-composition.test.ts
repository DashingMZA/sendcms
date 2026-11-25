// Phase 16, Wave 4 — Stream B.
//
// TST-016: snippet composition was untested, so two live defects
// shipped in the untested step — DSH-101 (the snippet pointed at the
// marketing origin, which serves neither /forms/v1.js nor the submit
// endpoint) and SDK-001 (the snippet omitted data-turnstile-site-key,
// so Turnstile-enabled forms 422d every submission). The builder now
// lives in @sendcms/sdk/snippet and takes the site key explicitly;
// these tests pin the composition for both form states, and pin the
// dashboard page wiring that passes the API origin (not the marketing
// origin) plus the site key.
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { buildEmbedSnippet, type EmbedSnippetForm } from "@sendcms/sdk/snippet"

const repoRoot = path.resolve(import.meta.dirname, "..")

const API_ORIGIN = "https://api.sendcms.bond"
const SITE_KEY = "0x4AAAAAAA_site_key"

function form(turnstileEnabled: boolean): EmbedSnippetForm {
  return {
    id: "form-1",
    ownerId: "user-1",
    turnstileEnabled,
    fields: [
      {
        name: "email",
        label: "Email",
        type: "EMAIL",
        required: true,
        placeholder: "you@example.com",
      },
    ],
  }
}

describe("TST-016 snippet composition", () => {
  it("points the script at the API origin (DSH-101)", () => {
    const snippet = buildEmbedSnippet(API_ORIGIN, form(false))
    expect(snippet).toContain(
      `<script src="${API_ORIGIN}/forms/v1.js" data-user-id="user-1" data-form-id="form-1">`
    )
    // The bare marketing origin (no api subdomain) must never serve
    // the script — that was DSH-101.
    expect(snippet).not.toContain('"https://sendcms.bond/forms')
    expect(snippet).not.toContain("localhost:3000/forms")
  })

  it("includes data-turnstile-site-key when Turnstile is on and a key is given (SDK-001)", () => {
    const snippet = buildEmbedSnippet(API_ORIGIN, form(true), SITE_KEY)
    expect(snippet).toContain(`data-turnstile-site-key="${SITE_KEY}"`)
  })

  it("omits the Turnstile attribute when Turnstile is on but no key is given", () => {
    const snippet = buildEmbedSnippet(API_ORIGIN, form(true), null)
    expect(snippet).not.toContain("data-turnstile-site-key")
  })

  it("omits the Turnstile attribute when Turnstile is off, even with a key", () => {
    const snippet = buildEmbedSnippet(API_ORIGIN, form(false), SITE_KEY)
    expect(snippet).not.toContain("data-turnstile-site-key")
  })

  it("the dashboard page passes the API origin and the site key (DSH-101/SDK-001 wiring)", () => {
    const page = readFileSync(
      path.join(
        repoRoot,
        "apps/dashboard/app/dashboard/forms/[formId]/page.tsx"
      ),
      "utf8"
    )
    expect(page).toContain("NEXT_PUBLIC_API_URL")
    expect(page).not.toContain("NEXT_PUBLIC_APP_URL")
    expect(page).toContain("NEXT_PUBLIC_TURNSTILE_SITE_KEY")
    const detail = readFileSync(
      path.join(
        repoRoot,
        "apps/dashboard/app/dashboard/forms/[formId]/form-detail.tsx"
      ),
      "utf8"
    )
    expect(detail).toContain("turnstileSiteKey")
    expect(detail).toContain(
      "buildEmbedSnippet(appUrl, form, turnstileSiteKey)"
    )
  })
})
