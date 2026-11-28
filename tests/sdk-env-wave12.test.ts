// SRC-309 (Phase 16, Wave 12): `.env.local` must override `.env` when
// the SDK build inlines `__APP_URL__`. The old loader used
// set-if-absent for both files, so `.env` always won and a
// `.env.local` override silently did nothing.
import { execFileSync } from "node:child_process"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadEnvFiles, parseEnvLine } from "../packages/sdk/src/env"

const ROOT = join(import.meta.dirname, "..")

describe("parseEnvLine", () => {
  it("parses a plain KEY=value line", () => {
    expect(parseEnvLine("NEXT_PUBLIC_API_URL=https://a.example")).toEqual([
      "NEXT_PUBLIC_API_URL",
      "https://a.example",
    ])
  })

  it("strips surrounding quotes", () => {
    expect(parseEnvLine('KEY="https://a.example"')).toEqual([
      "KEY",
      "https://a.example",
    ])
    expect(parseEnvLine("KEY='https://a.example'")).toEqual([
      "KEY",
      "https://a.example",
    ])
  })

  it("handles an `export KEY=` prefix", () => {
    expect(parseEnvLine("export KEY=value")).toEqual(["KEY", "value"])
  })

  it("strips inline comments on unquoted values, keeps them in quoted ones", () => {
    expect(parseEnvLine("KEY=value # a comment")).toEqual(["KEY", "value"])
    expect(parseEnvLine('KEY="value # not a comment"')).toEqual([
      "KEY",
      "value # not a comment",
    ])
  })

  it("returns null for blanks, comments, and lines without `=`", () => {
    expect(parseEnvLine("")).toBeNull()
    expect(parseEnvLine("   ")).toBeNull()
    expect(parseEnvLine("# just a comment")).toBeNull()
    expect(parseEnvLine("NOEQUALS")).toBeNull()
    expect(parseEnvLine("=value")).toBeNull()
  })
})

describe("loadEnvFiles precedence", () => {
  function fixture(
    envContent: string,
    envLocalContent: string
  ): { envPath: string; envLocalPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "sendcms-sdk-env-"))
    const envPath = join(dir, ".env")
    const envLocalPath = join(dir, ".env.local")
    writeFileSync(envPath, envContent)
    writeFileSync(envLocalPath, envLocalContent)
    return { envPath, envLocalPath }
  }

  it(".env.local overrides .env for the same key", () => {
    const { envPath, envLocalPath } = fixture(
      "NEXT_PUBLIC_API_URL=https://a.example\n",
      "NEXT_PUBLIC_API_URL=https://b.example\n"
    )
    const env: NodeJS.ProcessEnv = {}
    loadEnvFiles(envPath, envLocalPath, env)
    expect(env.NEXT_PUBLIC_API_URL).toBe("https://b.example")
  })

  it("keys only in one file are all loaded", () => {
    const { envPath, envLocalPath } = fixture(
      "ONLY_ENV=one\n",
      "ONLY_LOCAL=two\n"
    )
    const env: NodeJS.ProcessEnv = {}
    loadEnvFiles(envPath, envLocalPath, env)
    expect(env.ONLY_ENV).toBe("one")
    expect(env.ONLY_LOCAL).toBe("two")
  })

  it("the real process environment wins over both files", () => {
    const { envPath, envLocalPath } = fixture(
      "SHARED=https://a.example\n",
      "SHARED=https://b.example\n"
    )
    const env: NodeJS.ProcessEnv = { SHARED: "https://real.example" }
    loadEnvFiles(envPath, envLocalPath, env)
    expect(env.SHARED).toBe("https://real.example")
  })

  it("tolerates missing files", () => {
    const env: NodeJS.ProcessEnv = {}
    expect(() =>
      loadEnvFiles(
        join(tmpdir(), "sendcms-does-not-exist.env"),
        join(tmpdir(), "sendcms-does-not-exist.env.local"),
        env
      )
    ).not.toThrow()
    expect(env).toEqual({})
  })
})

describe("SDK build inlines the .env.local URL", () => {
  it("builds v1.js with the .env.local NEXT_PUBLIC_API_URL, not the .env one", () => {
    // Isolated copy of the SDK build (SRC-309): the build resolves
    // .env / .env.local relative to its own location, so a copy under
    // a temp dir reads fixture files there — the repo's own .env (and
    // the shared built bundle other tests read) are never touched.
    // The copy mirrors the real layout (packages/sdk) so the build's
    // `../../.env` and `../../apps/api/public/forms` relatives land
    // inside the temp dir.
    const dir = mkdtempSync(join(tmpdir(), "sendcms-sdk-build-"))
    const sdkDir = join(dir, "packages/sdk")
    mkdirSync(sdkDir, { recursive: true })
    cpSync(join(ROOT, "packages/sdk/build.ts"), join(sdkDir, "build.ts"))
    cpSync(join(ROOT, "packages/sdk/build.ts"), join(sdkDir, "build.ts"))
    cpSync(
      join(ROOT, "packages/sdk/package.json"),
      join(sdkDir, "package.json")
    )
    cpSync(join(ROOT, "packages/sdk/src"), join(sdkDir, "src"), {
      recursive: true,
    })
    symlinkSync(
      join(ROOT, "packages/sdk/node_modules"),
      join(sdkDir, "node_modules")
    )
    mkdirSync(join(dir, "apps/api/public/forms"), { recursive: true })
    writeFileSync(join(dir, ".env"), "NEXT_PUBLIC_API_URL=https://a.example\n")
    writeFileSync(
      join(dir, ".env.local"),
      "NEXT_PUBLIC_API_URL=https://b.example\n"
    )
    const env = { ...process.env }
    delete env.NEXT_PUBLIC_API_URL
    delete env.NEXT_PUBLIC_APP_URL
    execFileSync(
      join(ROOT, "node_modules/.bin/tsx"),
      [join(sdkDir, "build.ts")],
      { cwd: ROOT, env, stdio: "pipe" }
    )
    const bundle = readFileSync(
      join(dir, "apps/api/public/forms/v1.js"),
      "utf8"
    )
    expect(bundle).toContain("https://b.example")
    expect(bundle).not.toContain("https://a.example")
  })
})
