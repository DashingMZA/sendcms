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

// These tests load the REAL built bundle (public/forms/v1.js) and drive
// it with mocked fetch.
//
// jsdom quirk (verified): a <script> element appended to the document
// DOES execute (DOM effects are visible), but its JS globals land in
// the jsdom window's own vm context — not on the test file's `window`.
// So the bundle is loaded with `window.eval(bundle)` (same context as
// the test, so `window.fetch` mocks and `window.SendCMS` are shared),
// except for the one script-tag test, which asserts DOM effects only.

const bundle = readFileSync(
  resolve(import.meta.dirname, "../public/forms/v1.js"),
  "utf8"
)

const FORM_HTML = `
<form data-cms-form data-user-id="user-1" data-form-id="form-1">
  <input name="name" value="Ali">
  <input name="email" type="email" value="ali@example.com">
  <textarea name="message">Hello there</textarea>
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

/** Loads the bundle in the test's own context and enhances the page. */
function loadSdk(bodyHtml = FORM_HTML) {
  document.head.innerHTML = ""
  document.body.innerHTML = bodyHtml
  window.eval(bundle)
  return window.SendCMS!
}

/** Loads the bundle the way a visitor's page does — as a <script>
    element. Only DOM effects are observable from the test. */
function loadSdkAsScriptTag(
  scriptAttrs: Record<string, string>,
  bodyHtml = FORM_HTML
) {
  document.head.innerHTML = ""
  document.body.innerHTML = bodyHtml
  const script = document.createElement("script")
  for (const [key, value] of Object.entries(scriptAttrs)) {
    script.setAttribute(`data-${key}`, value)
  }
  script.textContent = bundle
  document.head.appendChild(script)
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

describe("SDK bundle", () => {
  it("auto-enhances forms from the script tag's data attributes", () => {
    loadSdkAsScriptTag({ "user-id": "user-1", "form-id": "form-1" })
    const form = document.querySelector("form")!
    expect(form.hasAttribute("data-sc-enhanced")).toBe(true)
    expect(form.querySelector('input[name="_sendcms_honeypot"]')).not.toBeNull()
    expect(document.querySelector("style[data-sendcms]")).not.toBeNull()
  })

  it("submits and shows the server success message", async () => {
    const onSuccess = vi.fn()
    const api = loadSdk()
    api.init({ onSuccess })
    const fetchMock = mockFetch(201, {
      ok: true,
      id: "sub-1",
      message: "Thanks! We'll get back to you.",
      redirectUrl: null,
    })
    const form = document.querySelector("form")!
    // Type over a value so reset() has something to restore.
    ;(form.querySelector('[name="name"]') as HTMLInputElement).value = "Bob"

    submitForm(form)
    await tick(50)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = lastBody(fetchMock)
    expect(body.userId).toBe("user-1")
    expect(body.formId).toBe("form-1")
    expect(body.fields).toEqual({
      name: "Bob",
      email: "ali@example.com",
      message: "Hello there",
    })
    expect(body.pageUrl).toBe("http://localhost:3000/")
    expect(body._sendcms_honeypot).toBe("")
    expect(typeof body.idempotencyKey).toBe("string")
    const status = form.querySelector(".sc-status")!
    expect(status.textContent).toBe("Thanks! We'll get back to you.")
    expect(status.className).toContain("sc-status--success")
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onSuccess.mock.calls[0][0].id).toBe("sub-1")
    // Form reset after success restores the inputs' default values.
    expect(
      (form.querySelector('[name="name"]') as HTMLInputElement).value
    ).toBe("Ali")
    expect(
      (form.querySelector('button[type="submit"]') as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("shows the server error and calls onError", async () => {
    const onError = vi.fn()
    const api = loadSdk()
    api.init({ onError })
    mockFetch(422, { error: '"Email" is required' })
    const form = document.querySelector("form")!

    submitForm(form)
    await tick(50)
    const status = form.querySelector(".sc-status")!
    expect(status.textContent).toBe('"Email" is required')
    expect(status.className).toContain("sc-status--error")
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].status).toBe(422)
  })

  it("ignores a second submit while one is in flight", async () => {
    loadSdk()
    let resolveFetch!: (v: unknown) => void
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        })
    )
    window.fetch = fetchMock as unknown as typeof fetch
    const form = document.querySelector("form")!
    submitForm(form)
    submitForm(form)
    await tick()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(
      (form.querySelector('button[type="submit"]') as HTMLButtonElement)
        .disabled
    ).toBe(true)
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
    expect(
      (form.querySelector('button[type="submit"]') as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("supports several forms with different form ids on one page", async () => {
    loadSdk(
      `<form data-cms-form data-user-id="user-1" data-form-id="form-a">
         <input name="name" value="A"><button type="submit">Send</button>
       </form>
       <form data-cms-form data-user-id="user-1" data-form-id="form-b">
         <input name="name" value="B"><button type="submit">Send</button>
       </form>`
    )
    const fetchMock = mockFetch(201, {
      ok: true,
      id: "sub-2",
      message: "Thanks!",
      redirectUrl: null,
    })
    const forms = document.querySelectorAll("form")
    expect(forms).toHaveLength(2)
    submitForm(forms[1])
    await tick(50)
    expect(lastBody(fetchMock).formId).toBe("form-b")
    expect((lastBody(fetchMock).fields as Record<string, string>).name).toBe(
      "B"
    )
  })

  it("enhances forms added after load (SPA navigation)", async () => {
    loadSdk()
    const form = document.createElement("form")
    form.setAttribute("data-cms-form", "")
    form.setAttribute("data-user-id", "user-1")
    form.setAttribute("data-form-id", "form-1")
    form.innerHTML = `<input name="name" value="Late"><button type="submit">Send</button>`
    document.body.appendChild(form)
    await tick()
    expect(form.hasAttribute("data-sc-enhanced")).toBe(true)
  })

  it("sends the honeypot value when a bot fills it", async () => {
    loadSdk()
    const fetchMock = mockFetch(201, {
      ok: true,
      id: "fake",
      message: "Thanks!",
      redirectUrl: null,
    })
    const form = document.querySelector("form")!
    const trap = form.querySelector(
      'input[name="_sendcms_honeypot"]'
    ) as HTMLInputElement
    trap.value = "http://bot.example"
    submitForm(form)
    await tick(50)
    expect(lastBody(fetchMock)._sendcms_honeypot).toBe("http://bot.example")
  })

  it("exposes a programmatic submit()", async () => {
    const api = loadSdk()
    mockFetch(201, {
      ok: true,
      id: "sub-9",
      message: "Thanks!",
      redirectUrl: null,
    })
    const form = document.querySelector("form")!
    const result = await api.submit(form, {
      name: "Direct",
      email: "d@example.com",
      message: "Hi",
    })
    expect(result.id).toBe("sub-9")
    expect(result.ok).toBe(true)
  })

  it("does not load Turnstile when no site key is configured", async () => {
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
    expect(lastBody(fetchMock).turnstileToken).toBeUndefined()
    expect(document.querySelector('script[src*="turnstile"]')).toBeNull()
  })
})
