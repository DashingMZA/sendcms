import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import path from "node:path"
import { bucketByDay } from "@sendcms/analytics"

import {
  buildEmbedSnippet,
  buildFormExample,
  buildRestExample,
  buildSdkScriptTag,
} from "@sendcms/sdk/snippet"

const NOW = new Date("2026-11-17T12:00:00.000Z")

describe("bucketByDay", () => {
  it("returns one bucket per day, ending today, with zeros for empty days", () => {
    const buckets = bucketByDay([], 3, NOW)
    expect(buckets).toEqual([
      { date: "2026-11-15", count: 0 },
      { date: "2026-11-16", count: 0 },
      { date: "2026-11-17", count: 0 },
    ])
  })

  it("counts timestamps on their UTC day", () => {
    const buckets = bucketByDay(
      [
        new Date("2026-11-16T23:59:59.000Z"),
        new Date("2026-11-17T00:00:01.000Z"),
        new Date("2026-11-17T11:00:00.000Z"),
      ],
      2,
      NOW
    )
    expect(buckets).toEqual([
      { date: "2026-11-16", count: 1 },
      { date: "2026-11-17", count: 2 },
    ])
  })

  it("ignores dates outside the window", () => {
    const buckets = bucketByDay([new Date("2026-11-01T12:00:00.000Z")], 3, NOW)
    expect(buckets.every((bucket) => bucket.count === 0)).toBe(true)
  })
})

describe("SDK snippet builders", () => {
  const appUrl = "https://sendcms.example"
  const userId = "user-123"

  it("builds a script tag with the app url and user id", () => {
    expect(buildSdkScriptTag(appUrl, userId)).toBe(
      '<script src="https://sendcms.example/forms/v1.js" data-user-id="user-123"></script>'
    )
  })

  it("builds a form example with the data-cms-form marker", () => {
    const snippet = buildFormExample(appUrl, userId)
    expect(snippet).toContain("data-cms-form")
    expect(snippet).toContain('data-form-id="YOUR_FORM_ID"')
    expect(snippet).toContain(buildSdkScriptTag(appUrl, userId))
  })

  it("builds a REST curl example against the public submit endpoint", () => {
    const snippet = buildRestExample(appUrl, userId)
    expect(snippet).toContain(
      "POST https://sendcms.example/api/public/v1/submit"
    )
    expect(snippet).toContain('"userId": "user-123"')
    expect(snippet).toContain("Origin: https://your-site.example")
  })
})

describe("per-form embed snippet (DSH-101 / SDK-001)", () => {
  // The form-detail page passes the API origin (NEXT_PUBLIC_API_URL)
  // as appUrl — never the marketing origin.
  const apiUrl = "http://localhost:3001"
  const form = {
    id: "form-1",
    ownerId: "user-1",
    turnstileEnabled: false,
    fields: [
      {
        name: "name",
        label: "Name",
        type: "TEXT",
        required: true,
        placeholder: null,
        options: undefined,
      },
      {
        name: "email",
        label: "Email",
        type: "EMAIL",
        required: true,
        placeholder: null,
        options: undefined,
      },
    ],
  }

  it("points the script src at the api origin, not the marketing origin", () => {
    const snippet = buildEmbedSnippet(apiUrl, form)
    expect(snippet).toContain('<script src="http://localhost:3001/forms/v1.js"')
    expect(snippet).not.toContain("localhost:3000")
    expect(snippet).toContain('data-user-id="user-1"')
    expect(snippet).toContain('data-form-id="form-1"')
    expect(snippet).toContain("<form data-cms-form>")
  })

  it("emits data-turnstile-site-key for a Turnstile form when a key is given", () => {
    const snippet = buildEmbedSnippet(
      apiUrl,
      {
        ...form,
        turnstileEnabled: true,
      },
      "0x4AAAAAAA-test-key"
    )
    expect(snippet).toContain('data-turnstile-site-key="0x4AAAAAAA-test-key"')
  })

  it("omits the site key when Turnstile is on but no key is configured", () => {
    const snippet = buildEmbedSnippet(apiUrl, {
      ...form,
      turnstileEnabled: true,
    })
    expect(snippet).not.toContain("data-turnstile-site-key")
  })

  it("omits the site key when Turnstile is off even if a key is given", () => {
    const snippet = buildEmbedSnippet(apiUrl, form, "0x4AAAAAAA-test-key")
    expect(snippet).not.toContain("data-turnstile-site-key")
  })
})

// DSH-104 / DSH-204 / DSH-409: a loading.tsx wraps its segment's page
// AND every child route in Suspense, so a boundary above a detail
// segment streams a 200 shell before the page can call notFound() — a
// missing or foreign resource then renders the 404 UI with HTTP 200
// (soft 404). The list/overview skeletons therefore live in route
// groups ((list), (overview)) that wrap only their own page; no
// loading.tsx may sit on the path above a detail segment. This test
// fails the moment someone adds one back.
describe("detail pages have no loading boundary above them", () => {
  const DETAIL_SEGMENTS = [
    "apps/dashboard/app/dashboard/domains/[domainId]",
    "apps/dashboard/app/dashboard/forms/[formId]",
    "apps/dashboard/app/dashboard/inbox/[submissionId]",
    "apps/dashboard/app/dashboard/support/[ticketId]",
  ]

  function ancestorsAbove(segment: string): string[] {
    const ancestors: string[] = []
    const parts = segment.split("/")
    // Every ancestor directory from apps/dashboard down to (but
    // excluding) the detail segment itself.
    for (let i = 2; i < parts.length; i++) {
      ancestors.push(parts.slice(0, i).join("/"))
    }
    return ancestors
  }

  it.each(DETAIL_SEGMENTS)("no loading.tsx above %s", (segment) => {
    for (const dir of ancestorsAbove(segment)) {
      expect(
        existsSync(path.join(dir, "loading.tsx")),
        `${dir}/loading.tsx would soft-404 ${segment}`
      ).toBe(false)
    }
    // And the detail segment itself has no loading boundary either:
    // its page's notFound() must run before anything streams.
    expect(
      existsSync(path.join(segment, "loading.tsx")),
      `${segment}/loading.tsx would soft-404 its own page`
    ).toBe(false)
  })

  it("keeps the list/overview skeletons in their route groups", () => {
    for (const groupLoading of [
      "apps/dashboard/app/dashboard/(overview)/loading.tsx",
      "apps/dashboard/app/dashboard/domains/(list)/loading.tsx",
      "apps/dashboard/app/dashboard/forms/(list)/loading.tsx",
      "apps/dashboard/app/dashboard/inbox/(list)/loading.tsx",
    ]) {
      expect(existsSync(groupLoading), `${groupLoading} is missing`).toBe(true)
    }
  })
})
