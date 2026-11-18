import { describe, expect, it } from "vitest"
import { bucketByDay } from "@sendcms/analytics"

import {
  buildFormExample,
  buildRestExample,
  buildSdkScriptTag,
} from "@/lib/sdk-snippet"

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
