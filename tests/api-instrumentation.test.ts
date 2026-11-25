// SDK-016: the api startup check logs loudly when Turnstile is
// enabled on forms but TURNSTILE_SECRET_KEY is unset — and stays
// quiet otherwise. The logger writes JSON lines to stderr (error)
// and stdout (warn), so the test spies on the process streams.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockCount = vi.hoisted(() => vi.fn())
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: { ...actual.db, form: { count: mockCount } } }
})

import { register } from "../apps/api/instrumentation"

const originalSecret = process.env.TURNSTILE_SECRET_KEY
const originalRuntime = process.env.NEXT_RUNTIME

let stderrSpy: ReturnType<typeof vi.spyOn>
let stdoutSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_RUNTIME = "nodejs"
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
})

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.TURNSTILE_SECRET_KEY
  } else {
    process.env.TURNSTILE_SECRET_KEY = originalSecret
  }
  if (originalRuntime === undefined) {
    delete process.env.NEXT_RUNTIME
  } else {
    process.env.NEXT_RUNTIME = originalRuntime
  }
  stderrSpy.mockRestore()
  stdoutSpy.mockRestore()
})

function stderrText() {
  return stderrSpy.mock.calls
    .map((call: [unknown, ...unknown[]]) => String(call[0]))
    .join("\n")
}

function stdoutText() {
  return stdoutSpy.mock.calls
    .map((call: [unknown, ...unknown[]]) => String(call[0]))
    .join("\n")
}

describe("api instrumentation register() (SDK-016)", () => {
  it("logs an error when the secret is unset and forms have Turnstile on", async () => {
    delete process.env.TURNSTILE_SECRET_KEY
    mockCount.mockResolvedValue(2)
    await register()
    expect(mockCount).toHaveBeenCalledWith({
      where: { turnstileEnabled: true, deletedAt: null },
    })
    expect(stderrText()).toContain("TURNSTILE_SECRET_KEY is unset")
    expect(stderrText()).toContain("2 form(s)")
  })

  it("stays quiet when no form has Turnstile on", async () => {
    delete process.env.TURNSTILE_SECRET_KEY
    mockCount.mockResolvedValue(0)
    await register()
    expect(stderrText()).toBe("")
    expect(stdoutText()).toBe("")
  })

  it("stays quiet when the secret is set", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret"
    mockCount.mockResolvedValue(3)
    await register()
    expect(mockCount).not.toHaveBeenCalled()
    expect(stderrText()).toBe("")
  })

  it("warns (and does not throw) when the check itself fails", async () => {
    delete process.env.TURNSTILE_SECRET_KEY
    mockCount.mockRejectedValue(new Error("db down"))
    await expect(register()).resolves.toBeUndefined()
    expect(stderrText()).toBe("")
    expect(stdoutText()).toContain("turnstile startup check failed")
  })

  it("does nothing outside the Node.js runtime", async () => {
    delete process.env.NEXT_RUNTIME
    delete process.env.TURNSTILE_SECRET_KEY
    mockCount.mockResolvedValue(2)
    await register()
    expect(mockCount).not.toHaveBeenCalled()
  })
})
