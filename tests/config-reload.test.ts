// SRC-327 regression tests: rate-limit and step-up config reload
// within 60 seconds instead of being cached forever per process. The
// readers resolve config/config.json from the workspace root; this
// file mocks node:fs so the config content is controllable without
// touching the repo file (other test files read the same file in
// parallel, so mutating it here would flake them). No test hits the
// real DB.
import { describe, expect, it, vi } from "vitest"

const { fakeConfig } = vi.hoisted(() => ({
  fakeConfig: {
    content: JSON.stringify({
      platform: { emergency: false },
      rateLimits: {
        adminApi: { perMinute: 600, perHour: 10000 },
        authSignIn: { perMinutePerIp: 20, perMinutePerEmail: 10 },
      },
      stepUp: { ttlMinutes: 10, maxAttemptsPerHour: 5 },
    }),
  },
}))

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    existsSync: (path: string) => {
      // The config file and the workspace marker always exist; every
      // other path delegates to the real fs.
      if (path.endsWith("config/config.json")) return true
      if (path.endsWith("pnpm-workspace.yaml")) return true
      return actual.existsSync(path)
    },
    readFileSync: ((path: unknown, encoding: unknown) => {
      if (typeof path === "string" && path.endsWith("config/config.json")) {
        return fakeConfig.content
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(
        path,
        encoding
      )
    }) as typeof actual.readFileSync,
  }
})

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: {} }
})

import {
  RATE_LIMIT_CONFIG_CACHE_TTL_MS,
  readRateLimitConfig,
  readStepUpConfig,
  resetRateLimitConfigCache,
  resetStepUpConfigCache,
  STEP_UP_CONFIG_CACHE_TTL_MS,
} from "@sendcms/security"

const T0 = new Date("2026-11-24T00:00:00.000Z")
const T0_PLUS_30S = new Date(T0.getTime() + 30_000)
const T0_PLUS_61S = new Date(T0.getTime() + 61_000)

function setFakeConfig(values: {
  perMinutePerIp: number
  ttlMinutes: number
}): void {
  fakeConfig.content = JSON.stringify({
    platform: { emergency: false },
    rateLimits: {
      adminApi: { perMinute: 600, perHour: 10000 },
      authSignIn: {
        perMinutePerIp: values.perMinutePerIp,
        perMinutePerEmail: 10,
      },
    },
    stepUp: { ttlMinutes: values.ttlMinutes, maxAttemptsPerHour: 5 },
  })
}

describe("config reload (SRC-327)", () => {
  it("reloads the rate-limit config after the TTL, not before", () => {
    expect(RATE_LIMIT_CONFIG_CACHE_TTL_MS).toBe(60_000)
    resetRateLimitConfigCache()
    setFakeConfig({ perMinutePerIp: 20, ttlMinutes: 10 })
    expect(readRateLimitConfig(T0).authSignIn.perMinutePerIp).toBe(20)
    // File changes within the TTL → still the cached values.
    setFakeConfig({ perMinutePerIp: 21, ttlMinutes: 10 })
    expect(readRateLimitConfig(T0_PLUS_30S).authSignIn.perMinutePerIp).toBe(20)
    // Past the TTL → the new values take effect without a restart.
    expect(readRateLimitConfig(T0_PLUS_61S).authSignIn.perMinutePerIp).toBe(21)
    resetRateLimitConfigCache()
  })

  it("reloads the step-up config after the TTL, not before", () => {
    expect(STEP_UP_CONFIG_CACHE_TTL_MS).toBe(60_000)
    resetStepUpConfigCache()
    setFakeConfig({ perMinutePerIp: 20, ttlMinutes: 10 })
    expect(readStepUpConfig(T0).ttlMinutes).toBe(10)
    setFakeConfig({ perMinutePerIp: 20, ttlMinutes: 11 })
    expect(readStepUpConfig(T0_PLUS_30S).ttlMinutes).toBe(10)
    expect(readStepUpConfig(T0_PLUS_61S).ttlMinutes).toBe(11)
    resetStepUpConfigCache()
  })
})
