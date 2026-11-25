// Builds the SendCMS form SDK bundle with esbuild — compile-time
// defines, minified production build +
// non-minified debug build.
//
//   pnpm sdk:build   # minified → apps/api/public/forms/v1.js + debug → apps/api/public/forms/v1.debug.js
//
// The bundle reads .env then .env.local for NEXT_PUBLIC_API_URL (the API
// app's public URL — the app that serves the bundle and the submit
// endpoint), falling back to NEXT_PUBLIC_APP_URL for the single-app era,
// then to the API app's dev port. The inlined __APP_URL__ is the fallback
// when the script tag's own origin cannot be determined. Never read
// process.env in sdk/src — the browser bundle has no env.

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
const envPath = resolve(import.meta.dirname, "../../.env")
const envLocalPath = resolve(import.meta.dirname, "../../.env.local")
loadEnvFile(envPath)
loadEnvFile(envLocalPath)

const appUrl =
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.NEXT_PUBLIC_APP_URL ??
  "http://localhost:3001"

// Single source of truth for the SDK version: the package's own
// version, inlined as __SDK_VERSION__ so the bundle's
// window.SendCMS.version can never disagree with package.json.
const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")
) as { version: string }

const commonOptions = {
  entryPoints: [resolve(import.meta.dirname, "src/index.ts")],
  bundle: true,
  format: "iife" as const,
  target: ["es2020"],
  define: {
    __APP_URL__: JSON.stringify(appUrl),
    __SDK_VERSION__: JSON.stringify(packageJson.version),
  } as Record<string, string>,
  logLevel: "info" as const,
}

// Production / minified build — served by the API app (apps/api/public),
// so the bundle's origin is the submit API's origin (the SDK posts to
// the script tag's own origin first). See ADR 0006.
await build({
  ...commonOptions,
  minify: true,
  outfile: resolve(import.meta.dirname, "../../apps/api/public/forms/v1.js"),
})

// Debug / non-minified build
await build({
  ...commonOptions,
  minify: false,
  outfile: resolve(
    import.meta.dirname,
    "../../apps/api/public/forms/v1.debug.js"
  ),
})
