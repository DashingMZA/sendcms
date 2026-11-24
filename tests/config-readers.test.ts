// DOC-018 regression tests: the config/config.json readers resolve
// the file relative to the package file as well as process.cwd(), and
// log a loud warning when the working-directory lookup fails. A test
// that starts a reader with process.cwd() in a directory with no
// workspace marker must see a warning — the old readers silently fell
// back to defaults (including emergency: false) in that case. No test
// hits the real DB.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_RATE_LIMIT_CONFIG,
  DEFAULT_STEP_UP_CONFIG,
  readRateLimitConfig,
  readStepUpConfig,
  resetRateLimitConfigCache,
  resetStepUpConfigCache,
} from "@sendcms/security"
import { readPlatformConfig, resetPlatformConfigCache } from "@sendcms/plans"

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: {} }
})

const repoRoot = process.cwd()

describe("config.json readers with no workspace marker in cwd (DOC-018)", () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>
  let stdoutLines: string[]
  let markerlessDir: string

  beforeEach(() => {
    stdoutLines = []
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown
    ) => {
      stdoutLines.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    markerlessDir = mkdtempSync(join(tmpdir(), "sendcms-config-reader-"))
  })

  afterEach(() => {
    process.chdir(repoRoot)
    resetRateLimitConfigCache()
    resetStepUpConfigCache()
    resetPlatformConfigCache()
    stdoutWrite.mockRestore()
    rmSync(markerlessDir, { recursive: true, force: true })
  })

  function warnEntries(scope: string): Record<string, unknown>[] {
    return stdoutLines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null &&
          entry.level === "warn" &&
          entry.scope === scope &&
          typeof entry.message === "string" &&
          entry.message.includes("config/config.json")
      )
  }

  it("rate-limit reader warns and still returns the configured values", () => {
    resetRateLimitConfigCache()
    process.chdir(markerlessDir)
    expect(readRateLimitConfig()).toEqual(DEFAULT_RATE_LIMIT_CONFIG)
    // The repo config carries the same values as the defaults, so the
    // values alone cannot prove the file was read — the warning is the
    // signal, and it must name the working-directory miss.
    const warnings = warnEntries("rate-limit")
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0].message).toContain("working directory")
    expect(warnings[0].configPath).toBe(join(repoRoot, "config", "config.json"))
  })

  it("step-up reader warns and still returns the configured values", () => {
    resetStepUpConfigCache()
    process.chdir(markerlessDir)
    expect(readStepUpConfig()).toEqual(DEFAULT_STEP_UP_CONFIG)
    const warnings = warnEntries("step-up")
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0].message).toContain("working directory")
    expect(warnings[0].configPath).toBe(join(repoRoot, "config", "config.json"))
  })

  it("platform reader warns and still returns the configured flag", () => {
    resetPlatformConfigCache()
    process.chdir(markerlessDir)
    expect(readPlatformConfig()).toEqual({ emergency: false })
    const warnings = warnEntries("plans")
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0].message).toContain("working directory")
    expect(warnings[0].configPath).toBe(join(repoRoot, "config", "config.json"))
  })

  it("stays silent when cwd is the workspace root", () => {
    resetRateLimitConfigCache()
    resetStepUpConfigCache()
    resetPlatformConfigCache()
    expect(readRateLimitConfig()).toEqual(DEFAULT_RATE_LIMIT_CONFIG)
    expect(readStepUpConfig()).toEqual(DEFAULT_STEP_UP_CONFIG)
    expect(readPlatformConfig()).toEqual({ emergency: false })
    expect(warnEntries("rate-limit")).toHaveLength(0)
    expect(warnEntries("step-up")).toHaveLength(0)
    expect(warnEntries("plans")).toHaveLength(0)
  })
})
