import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/error"
import {
  extractMetaTagToken,
  joinTxtSegments,
  lookupTxtRecords,
} from "@/lib/services/dns-verification"

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
