// Builds the SendCMS form SDK bundle with esbuild — compile-time
// defines, minified production build +
// non-minified debug build.
//
//   pnpm sdk:build   # minified → public/forms/v1.js + debug → public/forms/v1.debug.js
//
// The bundle reads .env then .env.local for NEXT_PUBLIC_APP_URL, which
// is inlined as __APP_URL__ (fallback when the script tag's own origin
// cannot be determined). Never read process.env in sdk/src — the
// browser bundle has no env.

import { build } from "esbuild"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"

function loadEnvFile(path: string) {
  if (!existsSync(path)) return
  const content = readFileSync(path, "utf8")
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    // Remove surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

// Load .env then .env.local (local overrides)
const envPath = resolve(import.meta.dirname, "../.env")
const envLocalPath = resolve(import.meta.dirname, "../.env.local")
loadEnvFile(envPath)
loadEnvFile(envLocalPath)

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"

const commonOptions = {
  entryPoints: [resolve(import.meta.dirname, "src/index.ts")],
  bundle: true,
  format: "iife" as const,
  target: ["es2020"],
  define: {
    __APP_URL__: JSON.stringify(appUrl),
  } as Record<string, string>,
  logLevel: "info" as const,
}

// Production / minified build
await build({
  ...commonOptions,
  minify: true,
  outfile: resolve(import.meta.dirname, "../public/forms/v1.js"),
})

// Debug / non-minified build
await build({
  ...commonOptions,
  minify: false,
  outfile: resolve(import.meta.dirname, "../public/forms/v1.debug.js"),
})
