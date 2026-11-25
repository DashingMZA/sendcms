// Phase 16, Wave 4 — Stream B.
//
// SRC-316: apiFetch had no timeout (a hung API route hung the
// dashboard query indefinitely) and its success path threw a raw
// SyntaxError on a 200 with an empty or non-JSON body, bypassing the
// ApiClientError contract the global onError toast handling expects.
// Both now surface as ApiClientError.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiClientError, apiFetch } from "@sendcms/shared"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("apiFetch success path (SRC-316)", () => {
  it("returns parsed JSON on a 200", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }))
    await expect(apiFetch<{ ok: boolean }>("/api/v1/x")).resolves.toEqual({
      ok: true,
    })
  })

  it("throws ApiClientError (not SyntaxError) on a 200 with an empty body", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 200 }))
    const err = (await apiFetch("/api/v1/x").catch(
      (e: unknown) => e as ApiClientError
    )) as ApiClientError
    expect(err).toBeInstanceOf(ApiClientError)
    expect(err.message).toBe("Invalid response")
    expect(err.status).toBe(200)
  })

  it("throws ApiClientError (not SyntaxError) on a 200 with a non-JSON body", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("not json", { status: 200 })
    )
    const err = (await apiFetch("/api/v1/x").catch(
      (e: unknown) => e as ApiClientError
    )) as ApiClientError
    expect(err).toBeInstanceOf(ApiClientError)
    expect(err.message).toBe("Invalid response")
  })

  it("returns undefined on a 204", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }))
    await expect(apiFetch("/api/v1/x")).resolves.toBeUndefined()
  })

  it("still throws ApiClientError with the server message on an error status", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "Nope" }, 422))
    const err = (await apiFetch("/api/v1/x").catch(
      (e: unknown) => e as ApiClientError
    )) as ApiClientError
    expect(err).toBeInstanceOf(ApiClientError)
    expect(err.message).toBe("Nope")
    expect(err.status).toBe(422)
  })
})

describe("apiFetch timeout (SRC-316)", () => {
  // NOTE: AbortSignal.timeout uses Node's internal timer, which
  // vitest's fake timers cannot advance — so this test waits out the
  // real 30 s timeout (with a 35 s test timeout). It is the only
  // wall-clock test in the suite; the 30 s cost is the price of
  // proving the timeout actually fires.
  it("rejects with ApiClientError 408 within 30 s on a never-resolving fetch", async () => {
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"))
          })
        })
    )
    const started = Date.now()
    const err = (await apiFetch("/api/v1/x").catch(
      (e: unknown) => e as ApiClientError
    )) as ApiClientError
    expect(err).toBeInstanceOf(ApiClientError)
    expect(err.message).toBe("Request timed out")
    expect(err.status).toBe(408)
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(28_000)
    expect(elapsed).toBeLessThan(45_000)
  }, 35_000)

  it("a caller-provided abort still propagates as-is (not remapped)", async () => {
    const controller = new AbortController()
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"))
          })
        })
    )
    const promise = apiFetch("/api/v1/x", { signal: controller.signal })
    const assertion = expect(promise).rejects.toBeInstanceOf(DOMException)
    controller.abort()
    await assertion
  })
})
