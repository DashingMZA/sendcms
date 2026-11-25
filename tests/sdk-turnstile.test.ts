/**
 * @vitest-environment jsdom
 */
import { readFileSync } from "fs"
import { resolve } from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
// Type-only: loads the SDK's global `Window` augmentation
// (`window.SendCMS`, `window.turnstile`) from the package.
import type {} from "@sendcms/sdk"

// Regression tests for the Turnstile path (SDK-005, SDK-014,
// SDK-039). The real Cloudflare script is never loaded: window.turnstile
// is stubbed per test, and the script-load cases drive the <script>
// element the SDK creates. Fake timers are used only where a timeout
// is the behaviour under test, so no test waits 15 real seconds.

const bundle = readFileSync(
  resolve(import.meta.dirname, "../apps/api/public/forms/v1.js"),
  "utf8"
)

const TURNSTILE_FORM_HTML = `
<form data-cms-form data-user-id="user-1" data-form-id="form-1" data-turnstile-site-key="test-site-key">
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

function loadSdk(bodyHtml = TURNSTILE_FORM_HTML) {
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

type TurnstileBehavior = "token" | "error" | "expired" | "never" | "throw"

function installTurnstileStub(behavior: TurnstileBehavior) {
  let options: {
    callback?: (token: string) => void
    "error-callback"?: () => void
    "expired-callback"?: () => void
  } = {}
  const stub = {
    render: vi.fn((_container: unknown, opts: typeof options) => {
      options = opts
      if (behavior === "throw") throw new Error("render boom")
      return "widget-1"
    }),
    execute: vi.fn(() => {
      if (behavior === "token") options.callback?.("test-token-123")
      if (behavior === "error") options["error-callback"]?.()
      if (behavior === "expired") options["expired-callback"]?.()
    }),
    remove: vi.fn(),
    ready: vi.fn((cb: () => void) => cb()),
  }
  window.turnstile = stub as unknown as NonNullable<Window["turnstile"]>
  return stub
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete window.turnstile
})

describe("Turnstile token path (SDK-014)", () => {
  it("sends the token on success and tears the widget down", async () => {
    const stub = installTurnstileStub("token")
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
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastBody(fetchMock).turnstileToken).toBe("test-token-123")
    expect(stub.remove).toHaveBeenCalledWith("widget-1")
    expect(form.querySelector('div[aria-hidden="true"]')).toBeNull()
    expect(form.querySelector(".sc-status")!.textContent).toBe("Thanks!")
  })

  it("fails closed on the error callback: no submission, widget removed", async () => {
    const stub = installTurnstileStub("error")
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
    expect(fetchMock).not.toHaveBeenCalled()
    expect(form.querySelector(".sc-status")!.textContent).toBe(
      "Bot verification failed. Please try again."
    )
    expect(
      (form.querySelector('button[type="submit"]') as HTMLButtonElement)
        .disabled
    ).toBe(false)
    expect(stub.remove).toHaveBeenCalledWith("widget-1")
  })

  it("fails closed on the expired callback", async () => {
    installTurnstileStub("expired")
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
    expect(fetchMock).not.toHaveBeenCalled()
    expect(form.querySelector(".sc-status")!.textContent).toBe(
      "Bot verification expired. Please try again."
    )
  })

  it("rejects instead of hanging when render() throws synchronously (SDK-005)", async () => {
    vi.useFakeTimers()
    installTurnstileStub("throw")
    loadSdk()
    const fetchMock = mockFetch(201, {
      ok: true,
      id: "sub-1",
      message: "Thanks!",
      redirectUrl: null,
    })
    const form = document.querySelector("form")!
    submitForm(form)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(form.querySelector(".sc-status")!.textContent).toBe("render boom")
    expect(
      (form.querySelector('button[type="submit"]') as HTMLButtonElement)
        .disabled
    ).toBe(false)
    // No leaked token timer: advancing past the timeout changes nothing.
    await vi.advanceTimersByTimeAsync(15000)
    expect(form.querySelector(".sc-status")!.textContent).toBe("render boom")
  })

  it("times the token wait out at 15 s, not 30 s (SDK-039)", async () => {
    vi.useFakeTimers()
    installTurnstileStub("never")
    loadSdk()
    const fetchMock = mockFetch(201, {
      ok: true,
      id: "sub-1",
      message: "Thanks!",
      redirectUrl: null,
    })
    const form = document.querySelector("form")!
    submitForm(form)
    await vi.advanceTimersByTimeAsync(0)
    // While waiting, the status shows the distinct verifying text.
    expect(form.querySelector(".sc-status")!.textContent).toBe("Verifying…")
    await vi.advanceTimersByTimeAsync(14000)
    expect(form.querySelector(".sc-status")!.textContent).toBe("Verifying…")
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(form.querySelector(".sc-status")!.textContent).toBe(
      "Bot verification timed out. Please try again."
    )
    expect(
      (form.querySelector('button[type="submit"]') as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })
})

describe("Turnstile script load (SDK-005 / SDK-014)", () => {
  it("fails closed when the script errors: no submission, button re-enabled", async () => {
    loadSdk()
    const fetchMock = mockFetch(201, {
      ok: true,
      id: "sub-1",
      message: "Thanks!",
      redirectUrl: null,
    })
    const form = document.querySelector("form")!
    submitForm(form)
    await tick()
    const script = document.querySelector('script[src*="turnstile"]')
    expect(script).not.toBeNull()
    script!.dispatchEvent(new Event("error"))
    await tick(50)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(form.querySelector(".sc-status")!.textContent).toBe(
      "Could not load the bot verification script."
    )
    expect(
      (form.querySelector('button[type="submit"]') as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("times a hung script load out at 15 s instead of hanging forever (SDK-005)", async () => {
    vi.useFakeTimers()
    loadSdk()
    const fetchMock = mockFetch(201, {
      ok: true,
      id: "sub-1",
      message: "Thanks!",
      redirectUrl: null,
    })
    const form = document.querySelector("form")!
    submitForm(form)
    await vi.advanceTimersByTimeAsync(0)
    expect(document.querySelector('script[src*="turnstile"]')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(15000)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(form.querySelector(".sc-status")!.textContent).toBe(
      "Could not load the bot verification script."
    )
    expect(
      (form.querySelector('button[type="submit"]') as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })
})
