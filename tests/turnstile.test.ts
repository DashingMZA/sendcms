import { afterEach, describe, expect, it, vi } from "vitest"
import { verifyTurnstileToken } from "@sendcms/submissions/turnstile"

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.TURNSTILE_SECRET_KEY
})

describe("verifyTurnstileToken", () => {
  it("returns false when no secret is configured", async () => {
    await expect(verifyTurnstileToken("token")).resolves.toBe(false)
  })

  it("returns true on a successful verification", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: true }),
      }))
    )
    await expect(verifyTurnstileToken("token", "1.2.3.4")).resolves.toBe(true)
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit]
    expect(url).toContain("challenges.cloudflare.com")
    expect(String(init.body)).toContain("secret=test-secret")
    expect(String(init.body)).toContain("remoteip=1.2.3.4")
  })

  it("returns false on failure, non-2xx and network errors", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ success: false }) }))
    )
    await expect(verifyTurnstileToken("token")).resolves.toBe(false)

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    )
    await expect(verifyTurnstileToken("token")).resolves.toBe(false)

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down")
      })
    )
    await expect(verifyTurnstileToken("token")).resolves.toBe(false)
  })
})
