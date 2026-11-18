import { describe, expect, it } from "vitest"
import {
  assertValidDomain,
  newChallenge,
  normalizeDomain,
} from "@sendcms/domains"

describe("normalizeDomain", () => {
  it.each([
    ["example.com", "example.com"],
    ["EXAMPLE.COM", "example.com"],
    ["https://example.com", "example.com"],
    ["http://www.example.com/blog?x=1#top", "example.com"],
    ["www.example.com", "example.com"],
    ["https://WWW.Example.COM.", "example.com"],
    ["example.com:8080/path", "example.com"],
    ["  blog.example.com  ", "blog.example.com"],
    ["user@example.com", "example.com"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected)
  })

  it("keeps subdomains other than www", () => {
    expect(normalizeDomain("blog.example.com")).toBe("blog.example.com")
    expect(normalizeDomain("app.shop.example.co.uk")).toBe(
      "app.shop.example.co.uk"
    )
  })
})

describe("assertValidDomain", () => {
  it.each(["example.com", "blog.example.com", "my-site.co.uk"])(
    "accepts %s",
    (input) => {
      expect(assertValidDomain(input)).toBe(input)
    }
  )

  it.each([
    "localhost",
    "127.0.0.1",
    "*.example.com",
    "example",
    "",
    "exa mple.com",
    "example..com",
    "-example.com",
  ])("rejects %s", (input) => {
    expect(() => assertValidDomain(input)).toThrow()
  })
})

describe("newChallenge", () => {
  it("returns a 48-char base64url token, unique each time", () => {
    const a = newChallenge()
    const b = newChallenge()
    expect(a).toMatch(/^[A-Za-z0-9_-]{48}$/)
    expect(a).not.toBe(b)
  })
})
