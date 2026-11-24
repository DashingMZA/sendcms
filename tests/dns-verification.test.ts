import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@sendcms/api-client"
import {
  checkVerification,
  extractMetaTagToken,
  isPrivateIp,
  joinTxtSegments,
  lookupTxtRecords,
  readCappedStream,
  type PinnedFetchResult,
} from "@sendcms/domains/dns-verification"

describe("joinTxtSegments", () => {
  it("unquotes a single segment", () => {
    expect(joinTxtSegments('"hello"')).toBe("hello")
  })

  it("joins multiple quoted segments", () => {
    expect(joinTxtSegments('"abc" "def" "ghi"')).toBe("abcdefghi")
  })

  it("passes an unquoted value through", () => {
    expect(joinTxtSegments("plain")).toBe("plain")
  })
})

describe("extractMetaTagToken", () => {
  it("reads name-then-content", () => {
    expect(
      extractMetaTagToken(
        '<html><head><meta name="sendcms-verification" content="tok123"></head>'
      )
    ).toBe("tok123")
  })

  it("reads content-then-name and single quotes", () => {
    expect(
      extractMetaTagToken("<meta content='tok456' name='sendcms-verification'>")
    ).toBe("tok456")
  })

  it("returns null when the tag is missing", () => {
    expect(extractMetaTagToken("<html><head></head>")).toBeNull()
  })
})

function dohResponse(status: number, answers: unknown[]) {
  return {
    ok: true,
    json: async () => ({ Status: status, Answer: answers }),
  }
}

describe("isPrivateIp (SEC-201 / SRC-232)", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.9.9.9", true],
    ["10.0.0.1", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["169.254.1.1", true],
    ["0.0.0.0", true],
    ["8.8.8.8", false],
    ["93.184.216.34", false],
    // IPv4-mapped IPv6 — the embedded v4 address decides.
    ["::ffff:127.0.0.1", true],
    ["::ffff:10.0.0.1", true],
    ["::ffff:192.168.0.5", true],
    ["::ffff:8.8.8.8", false],
    ["::ffff:7f00:1", true],
    ["0:0:0:0:0:ffff:127.0.0.1", true],
    // CGNAT / reserved ranges.
    ["100.64.0.1", true],
    ["100.127.255.255", true],
    ["100.128.0.1", false],
    ["192.0.0.1", true],
    ["192.0.1.1", false],
    ["198.18.0.1", true],
    ["198.19.255.255", true],
    ["198.20.0.1", false],
    // IPv6.
    ["::1", true],
    ["::", true],
    ["fe80::1", true],
    ["febf::1", true],
    ["fec0::1", false],
    ["fc00::1", true],
    ["fd12:3456::1", true],
    ["2001:db8::1", false],
  ])("%s -> %s", (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected)
  })
})

describe("readCappedStream (SRC-232)", () => {
  async function* chunks(list: string[]): AsyncGenerator<Uint8Array> {
    for (const item of list) yield new TextEncoder().encode(item)
  }

  it("returns the kept prefix with no trailing NUL padding", async () => {
    const body = await readCappedStream(chunks(["hello ", "world"]), 8)
    expect(body).toBe("hello ")
    expect(body.length).toBe(6)
    expect(body).not.toContain("\0")
  })

  it("keeps a body that exactly fits the cap", async () => {
    expect(await readCappedStream(chunks(["abc", "def"]), 6)).toBe("abcdef")
  })

  it("drops a first chunk that already exceeds the cap", async () => {
    const body = await readCappedStream(chunks(["toolong"]), 3)
    expect(body).toBe("")
  })
})

describe("checkVerification SSRF pinning (SEC-211 / SRC-232)", () => {
  const CHALLENGE = "tok-123"

  function metaBody(token: string) {
    return `<html><head><meta name="sendcms-verification" content="${token}"></head>`
  }

  it("fetches the checked public IP and accepts a matching meta tag", async () => {
    const pinnedGet = vi.fn(async (): Promise<PinnedFetchResult> => ({
      status: 200,
      location: null,
      body: metaBody(CHALLENGE),
    }))
    const result = await checkVerification(
      "example.com",
      "META_TAG",
      CHALLENGE,
      {
        resolveIps: async () => ["93.184.216.34"],
        pinnedGet,
      }
    )
    expect(result).toEqual({ ok: true })
    expect(pinnedGet).toHaveBeenCalledWith({
      hostname: "example.com",
      ip: "93.184.216.34",
      path: "/",
    })
  })

  it("refuses a host that resolves to a private or mapped-private IP without fetching", async () => {
    for (const ip of ["127.0.0.1", "::ffff:127.0.0.1", "100.64.0.9"]) {
      const pinnedGet = vi.fn(async (): Promise<PinnedFetchResult> => ({
        status: 200,
        location: null,
        body: metaBody(CHALLENGE),
      }))
      const result = await checkVerification(
        "example.com",
        "META_TAG",
        CHALLENGE,
        {
          resolveIps: async () => [ip],
          pinnedGet,
        }
      )
      expect(result.ok).toBe(false)
      expect(pinnedGet).not.toHaveBeenCalled()
    }
  })

  it("re-resolves on redirect: a hop that flips to loopback is refused", async () => {
    const answers = [["93.184.216.34"], ["127.0.0.1"]]
    const pinnedGet = vi.fn(async (): Promise<PinnedFetchResult> => ({
      status: 302,
      location: "https://example.com/other",
      body: "",
    }))
    const result = await checkVerification(
      "example.com",
      "META_TAG",
      CHALLENGE,
      {
        resolveIps: async () => answers.shift() ?? ["127.0.0.1"],
        pinnedGet,
      }
    )
    expect(result.ok).toBe(false)
    // Only the first (public) hop was ever fetched — the rebinding
    // target was never connected to.
    expect(pinnedGet).toHaveBeenCalledTimes(1)
    expect(pinnedGet).toHaveBeenCalledWith({
      hostname: "example.com",
      ip: "93.184.216.34",
      path: "/",
    })
  })

  it("follows a same-host redirect to the same pinned IP", async () => {
    const pinnedGet = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        location: "https://example.com/real",
        body: "",
      } satisfies PinnedFetchResult)
      .mockResolvedValueOnce({
        status: 200,
        location: null,
        body: metaBody(CHALLENGE),
      } satisfies PinnedFetchResult)
    const result = await checkVerification(
      "example.com",
      "META_TAG",
      CHALLENGE,
      {
        resolveIps: async () => ["93.184.216.34"],
        pinnedGet,
      }
    )
    expect(result).toEqual({ ok: true })
    expect(pinnedGet).toHaveBeenCalledTimes(2)
    expect(pinnedGet.mock.calls[1]?.[0]).toMatchObject({ path: "/real" })
  })
})

describe("lookupTxtRecords", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns TXT values from Cloudflare", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      dohResponse(0, [
        { type: 16, data: '"sendcms-token-1"' },
        { type: 16, data: '"a" "b"' },
        { type: 1, data: "93.184.216.34" },
      ])
    )
    vi.stubGlobal("fetch", fetchMock)
    const records = await lookupTxtRecords("sendcms._domainkey.example.com")
    expect(records).toEqual(["sendcms-token-1", "ab"])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("cloudflare-dns.com")
  })

  it("returns an empty list on NXDOMAIN (Status 3)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(dohResponse(3, [])))
    await expect(
      lookupTxtRecords("sendcms._domainkey.example.com")
    ).resolves.toEqual([])
  })

  it("falls back to Google when Cloudflare is unreachable", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(dohResponse(0, [{ type: 16, data: '"tok"' }]))
    vi.stubGlobal("fetch", fetchMock)
    const records = await lookupTxtRecords("sendcms._domainkey.example.com")
    expect(records).toEqual(["tok"])
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("dns.google")
  })

  it("throws a 502 when both resolvers are unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")))
    await expect(
      lookupTxtRecords("sendcms._domainkey.example.com")
    ).rejects.toMatchObject({ status: 502 })
    try {
      await lookupTxtRecords("sendcms._domainkey.example.com")
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
    }
  })
})
