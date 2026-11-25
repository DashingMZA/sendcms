/**
 * @vitest-environment jsdom
 */
import { readFileSync } from "fs"
import { resolve } from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
// Type-only: loads the SDK's global `Window` augmentation (`window.SendCMS`)
// from the package. The root tsconfig no longer includes packages/, so the
// test imports the types explicitly instead of relying on the include.
import type {} from "@sendcms/sdk"

// Regression tests for the Phase 16 Wave 4 (Stream A) SDK fixes.
// Like tests/sdk.test.ts, these load the REAL built bundle
// (apps/api/public/forms/v1.js) with `window.eval(bundle)` — except
// the SDK-013 double-load test, which evals twice on purpose. Each
// load destroys the previous instance first (see loadSdk): the bundle
// guards against a second evaluation, so without destroy() a re-eval
// would be a no-op and the fresh form would never be enhanced.

const bundle = readFileSync(
  resolve(import.meta.dirname, "../apps/api/public/forms/v1.js"),
  "utf8"
)

const pkg = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../packages/sdk/package.json"),
    "utf8"
  )
) as { version: string }

const FORM_HTML = `
<form data-cms-form data-user-id="user-1" data-form-id="form-1">
  <input name="name" value="Ali">
  <input name="email" type="email" value="ali@example.com">
  <textarea name="message">Hello there</textarea>
  <button type="submit">Send</button>
</form>
`

// A form with no ids anywhere — ids must come from init().
const NO_ID_FORM_HTML = `
<form data-cms-form>
  <input name="name" value="Ali">
  <button type="submit">Send</button>
</form>
`

type FetchMock = ReturnType<typeof vi.fn>

function mockFetch(status: number, body: Record<string, unknown>) {
  const fn: FetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }))
  window.fetch = fn as unknown as typeof fetch
  return fn
}

function mockFetchRaw(status: number, jsonImpl: () => Promise<unknown>) {
  const fn: FetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: jsonImpl,
  }))
  window.fetch = fn as unknown as typeof fetch
  return fn
}

function loadSdk(bodyHtml = FORM_HTML) {
  window.SendCMS?.destroy?.()
  document.head.innerHTML = ""
  document.body.innerHTML = bodyHtml
  window.eval(bundle)
  return window.SendCMS!
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

function submitForm(form: HTMLFormElement) {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
}

function lastBody(fetchMock: FetchMock) {
  const call = fetchMock.mock.calls.at(-1)
  expect(call).toBeDefined()
  return JSON.parse(String(call![1].body)) as Record<string, unknown>
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("SDK init merging (SDK-002)", () => {
  it("ignores undefined-valued keys instead of wiping earlier init() values", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const api = loadSdk(NO_ID_FORM_HTML)
    // First init supplies the ids (autoInit warned once: no ids yet).
    api.init({ userId: "u-from-init", formId: "f-from-init" })
    expect(warn).toHaveBeenCalled()
    // A second init with explicit undefined must not clobber them.
    api.init({
      userId: undefined,
      formId: undefined,
      turnstileSiteKey: undefined,
    })
    const fetchMock = mockFetch(201, {
      ok: true,
      id: "sub-1",
      message: "Thanks!",
      redirectUrl: null,
    })
    const form = document.querySelector("form")!
    submitForm(form)
    await tick(50)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastBody(fetchMock).userId).toBe("u-from-init")
    expect(lastBody(fetchMock).formId).toBe("f-from-init")
  })

  it("keeps init() values set before DOMContentLoaded when autoInit runs", async () => {
    window.SendCMS?.destroy?.()
    document.head.innerHTML = ""
    document.body.innerHTML = NO_ID_FORM_HTML
    Object.defineProperty(document, "readyState", {
      value: "loading",
      configurable: true,
    })
    try {
      window.eval(bundle)
      const api = window.SendCMS!
      api.init({ userId: "u-dom", formId: "f-dom" })
      // init() scans, so the form is enhanced right away — the point
      // is that the DOMContentLoaded autoInit must not wipe those ids.
      expect(
        document.querySelector("form")!.hasAttribute("data-sc-enhanced")
      ).toBe(true)
      document.dispatchEvent(new Event("DOMContentLoaded"))
      await tick()
      expect(
        document.querySelector("form")!.hasAttribute("data-sc-enhanced")
      ).toBe(true)
      const fetchMock = mockFetch(201, {
        ok: true,
        id: "sub-1",
        message: "Thanks!",
        redirectUrl: null,
      })
      submitForm(document.querySelector("form")!)
      await tick(50)
      expect(lastBody(fetchMock).userId).toBe("u-dom")
      expect(lastBody(fetchMock).formId).toBe("f-dom")
    } finally {
      Object.defineProperty(document, "readyState", {
        value: "complete",
        configurable: true,
      })
    }
  })
})

describe("SDK late-form detection (SDK-003)", () => {
  it("enhances a form that gains data-cms-form and ids after load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    loadSdk(
      `<form><input name="name" value="Late"><button type="submit">Send</button></form>`
    )
    const form = document.querySelector("form")!
    expect(form.hasAttribute("data-sc-enhanced")).toBe(false)
    form.setAttribute("data-cms-form", "")
    form.setAttribute("data-user-id", "user-1")
    form.setAttribute("data-form-id", "form-1")
    await tick()
    expect(form.hasAttribute("data-sc-enhanced")).toBe(true)
  })

  it("re-resolves the config when data-form-id changes on an enhanced form", async () => {
    const api = loadSdk()
    api.init({})
    const fetchMock = mockFetch(201, {
      ok: true,
      id: "sub-1",
      message: "Thanks!",
      redirectUrl: null,
    })
    const form = document.querySelector("form")!
    form.setAttribute("data-form-id", "form-2")
    await tick()
    submitForm(form)
    await tick(50)
    expect(lastBody(fetchMock).formId).toBe("form-2")
  })
})

describe("SDK error surfacing (SDK-004 / SDK-035)", () => {
  it("shows a {message} body instead of the generic fallback (429)", async () => {
    loadSdk()
    mockFetch(429, { message: "Too many submissions. Please wait a minute." })
    const form = document.querySelector("form")!
    submitForm(form)
    await tick(50)
    const status = form.querySelector(".sc-status")!
    expect(status.textContent).toBe(
      "Too many submissions. Please wait a minute."
    )
    expect(status.className).toContain("sc-status--error")
  })

  it('never renders an object .error as "[object Object]"', async () => {
    loadSdk()
    mockFetch(422, { error: { code: 1 } })
    const form = document.querySelector("form")!
    submitForm(form)
    await tick(50)
    const status = form.querySelector(".sc-status")!
    expect(status.textContent).toBe("Submission failed (422).")
    expect(status.textContent).not.toContain("[object Object]")
  })

  it("falls back to a status generic on a non-JSON error body", async () => {
    loadSdk()
    mockFetchRaw(500, async () => {
      throw new Error("Unexpected token < in JSON")
    })
    const form = document.querySelector("form")!
    submitForm(form)
    await tick(50)
    const status = form.querySelector(".sc-status")!
    expect(status.textContent).toBe("Submission failed (500).")
  })
})

describe("SDK apiUrl resolution (SDK-006)", () => {
  it("warns when the API URL cannot be determined", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const api = loadSdk()
    api.init({ apiUrl: "" })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not determine the API URL")
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("apiUrl"))
  })

  it("submit() fails loudly instead of posting to the host site", async () => {
    const api = loadSdk()
    api.init({ apiUrl: "" })
    const form = document.querySelector("form")!
    await expect(api.submit(form)).rejects.toThrow(/apiUrl is empty/)
  })
})

describe("SDK version (SDK-007)", () => {
  it("exposes the package version, not a separate constant", () => {
    const api = loadSdk()
    expect(api.version).toBe(pkg.version)
    expect(bundle).toContain(`"${pkg.version}"`)
  })
})

describe("SDK enhance() refresh (SDK-008)", () => {
  it("applies new options when enhance() is called on an enhanced form", async () => {
    const onSuccess = vi.fn()
    const api = loadSdk()
    const form = document.querySelector("form")!
    expect(form.hasAttribute("data-sc-enhanced")).toBe(true)
    api.enhance(form, { onSuccess })
    mockFetch(201, {
      ok: true,
      id: "sub-1",
      message: "Thanks!",
      redirectUrl: null,
    })
    submitForm(form)
    await tick(50)
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onSuccess.mock.calls[0][0].id).toBe("sub-1")
  })
})

describe("SDK submit controls (SDK-009)", () => {
  it("shows Sending… on input[type=submit] and disables every submit control", async () => {
    loadSdk(
      `<form data-cms-form data-user-id="user-1" data-form-id="form-1">
         <input name="name" value="A">
         <input type="submit" value="Go">
         <button type="submit">Send</button>
         <button type="submit">Also send</button>
       </form>`
    )
    let resolveFetch!: (v: unknown) => void
    window.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        })
    ) as unknown as typeof fetch
    const form = document.querySelector("form")!
    const input = form.querySelector('input[type="submit"]') as HTMLInputElement
    const buttons = form.querySelectorAll("button[type=submit]")
    submitForm(form)
    await tick()
    expect(input.value).toBe("Sending…")
    expect(input.disabled).toBe(true)
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
      expect((button as HTMLButtonElement).textContent).toBe("Sending…")
    }
    resolveFetch({
      ok: true,
      status: 201,
      json: async () => ({
        ok: true,
        id: "sub-1",
        message: "Thanks!",
        redirectUrl: null,
      }),
    })
    await tick(50)
    expect(input.value).toBe("Go")
    expect(input.disabled).toBe(false)
    expect((buttons[0] as HTMLButtonElement).textContent).toBe("Send")
    expect((buttons[1] as HTMLButtonElement).textContent).toBe("Also send")
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false)
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false)
  })
})

describe("SDK file inputs (SDK-010)", () => {
  it("warns once per form that file inputs are not sent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const api = loadSdk(
      `<form data-cms-form data-user-id="user-1" data-form-id="form-1">
         <input name="name" value="A">
         <input type="file" name="attachment">
         <button type="submit">Send</button>
       </form>`
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("file input"))
    expect(warn).toHaveBeenCalledTimes(1)
    api.scan()
    mockFetch(201, {
      ok: true,
      id: "sub-1",
      message: "Thanks!",
      redirectUrl: null,
    })
    submitForm(document.querySelector("form")!)
    await tick(50)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe("SDK honeypot and styles reconciliation (SDK-011)", () => {
  it("adds/removes the trap when init() toggles honeypot", async () => {
    const api = loadSdk()
    const form = document.querySelector("form")!
    expect(form.querySelector('input[name="_sendcms_honeypot"]')).not.toBeNull()
    api.init({ honeypot: false })
    expect(form.querySelector('input[name="_sendcms_honeypot"]')).toBeNull()
    api.init({ honeypot: true })
    expect(form.querySelector('input[name="_sendcms_honeypot"]')).not.toBeNull()
  })

  it("re-injects styles when the style element is removed", () => {
    const api = loadSdk()
    expect(document.querySelector("style[data-sendcms]")).not.toBeNull()
    document.querySelector("style[data-sendcms]")!.remove()
    expect(document.querySelector("style[data-sendcms]")).toBeNull()
    api.scan()
    expect(document.querySelector("style[data-sendcms]")).not.toBeNull()
  })
})

describe("SDK lifecycle (SDK-013)", () => {
  it("a second bundle evaluation keeps the first instance's handlers", async () => {
    window.SendCMS?.destroy?.()
    document.head.innerHTML = ""
    document.body.innerHTML = FORM_HTML
    window.eval(bundle)
    // Second load: the guard must keep the first instance public.
    window.eval(bundle)
    const api = window.SendCMS!
    const onSuccess = vi.fn()
    api.init({ onSuccess })
    mockFetch(201, {
      ok: true,
      id: "sub-1",
      message: "Thanks!",
      redirectUrl: null,
    })
    submitForm(document.querySelector("form")!)
    await tick(50)
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  it("destroy() disconnects the observer so late forms stay unenhanced", async () => {
    const api = loadSdk()
    api.destroy()
    expect(window.SendCMS).toBeUndefined()
    const form = document.createElement("form")
    form.setAttribute("data-cms-form", "")
    form.setAttribute("data-user-id", "user-1")
    form.setAttribute("data-form-id", "form-1")
    form.innerHTML = `<input name="name" value="Late"><button type="submit">Send</button>`
    document.body.appendChild(form)
    await tick()
    expect(form.hasAttribute("data-sc-enhanced")).toBe(false)
    // A fresh load after destroy() starts clean and enhances again.
    window.eval(bundle)
    expect(form.hasAttribute("data-sc-enhanced")).toBe(true)
  })
})

describe("SDK missing ids (SDK-034)", () => {
  it("warns naming the missing ids instead of silently doing nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    loadSdk(NO_ID_FORM_HTML)
    const form = document.querySelector("form")!
    expect(form.hasAttribute("data-sc-enhanced")).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("missing userId and formId")
    )
  })
})

describe("SDK idempotency (SRC-308)", () => {
  it("reuses the same key when a retry follows a dropped first response", async () => {
    const api = loadSdk()
    const fetchMock: FetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 201,
          json: async () => ({
            ok: true,
            id: "sub-1",
            message: "Thanks!",
            redirectUrl: null,
          }),
        }) as Response
    )
    // First attempt: the network drops the request entirely.
    fetchMock.mockRejectedValueOnce(new Error("NetworkError"))
    window.fetch = fetchMock as unknown as typeof fetch
    const form = document.querySelector("form")!
    submitForm(form)
    await tick(50)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The user retries the same fill after the error.
    submitForm(form)
    await tick(50)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstKey = JSON.parse(String(fetchMock.mock.calls[0][1].body))
      .idempotencyKey as string
    const secondKey = JSON.parse(String(fetchMock.mock.calls[1][1].body))
      .idempotencyKey as string
    expect(firstKey).toBeTruthy()
    expect(secondKey).toBe(firstKey)
    expect(api).toBeDefined()
  })

  it("rotates the key after a confirmed success, so the next fill is new", async () => {
    loadSdk()
    const fetchMock = mockFetch(201, {
      ok: true,
      id: "sub-1",
      message: "Thanks!",
      redirectUrl: null,
    })
    const form = document.querySelector("form")!
    submitForm(form)
    await tick(50)
    submitForm(form)
    await tick(50)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstKey = JSON.parse(String(fetchMock.mock.calls[0][1].body))
      .idempotencyKey as string
    const secondKey = JSON.parse(String(fetchMock.mock.calls[1][1].body))
      .idempotencyKey as string
    expect(firstKey).toBeTruthy()
    expect(secondKey).not.toBe(firstKey)
  })

  it("concurrent programmatic submit() sends once", async () => {
    const api = loadSdk()
    const form = document.querySelector("form")!
    let resolveFetch: (value: Response) => void
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    const fetchMock: FetchMock = vi.fn(() => fetchPromise)
    window.fetch = fetchMock as unknown as typeof fetch
    const first = api.submit(form)
    const second = api.submit(form)
    await tick(10)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    resolveFetch!({
      ok: true,
      status: 201,
      json: async () => ({
        ok: true,
        id: "sub-1",
        message: "Thanks!",
        redirectUrl: null,
      }),
    } as Response)
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual(secondResult)
    expect(firstResult.id).toBe("sub-1")
  })

  it("a failed programmatic submit keeps the key for the retry", async () => {
    const api = loadSdk()
    const form = document.querySelector("form")!
    const fetchMock: FetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 201,
          json: async () => ({
            ok: true,
            id: "sub-1",
            message: "Thanks!",
            redirectUrl: null,
          }),
        }) as Response
    )
    fetchMock.mockRejectedValueOnce(new Error("NetworkError"))
    window.fetch = fetchMock as unknown as typeof fetch
    await expect(api.submit(form)).rejects.toMatchObject({
      message: expect.stringContaining("Could not reach the server"),
    })
    const result = await api.submit(form)
    expect(result.id).toBe("sub-1")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstKey = JSON.parse(String(fetchMock.mock.calls[0][1].body))
      .idempotencyKey as string
    const secondKey = JSON.parse(String(fetchMock.mock.calls[1][1].body))
      .idempotencyKey as string
    expect(secondKey).toBe(firstKey)
  })
})
