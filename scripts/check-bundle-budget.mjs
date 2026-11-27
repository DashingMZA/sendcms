/**
 * First-load JavaScript budget check (Phase 16, PRF-007, Wave 11).
 *
 * Measures a page's first-load JS the way a browser pays for it: fetch
 * the page HTML, take every same-origin `/_next/static/chunks/*.js`
 * it references, and sum their sizes — brotli, because that is what
 * the CDN serves. `noModule` scripts (the legacy polyfill chunk) are
 * reported separately and EXCLUDED from the modern total: browsers
 * that support modules never fetch them.
 *
 * Budgets (kB brotli, modern total) — from the PRF-007 regression
 * test in the finding: marketing `/` 250, dashboard `/sign-in` 300.
 * The budgets are deliberately tight: the three shared framework
 * chunks alone are ~219 kB brotli on marketing `/`, so any page
 * regression shows up here first.
 *
 * Usage (against a running production build — `next build` +
 * `next start`, e.g. marketing on :3110, dashboard on :3111):
 *
 *   node scripts/check-bundle-budget.mjs --app apps/marketing \
 *     --url http://localhost:3110/ --budget 250
 *   node scripts/check-bundle-budget.mjs --app apps/dashboard \
 *     --url http://localhost:3111/sign-in --budget 300
 *
 * Or offline, from a saved HTML file:
 *
 *   node scripts/check-bundle-budget.mjs --app apps/marketing \
 *     --html /tmp/mkt.html --budget 250
 *
 * Exit code 0 = within budget, 1 = over budget (or a script could
 * not be read). CI wiring is owner-side: `.github/workflows/*` is
 * outside this stream's scope — add a step that builds the app,
 * starts it, and runs this script; the exit code is the gate.
 *
 * Measured baselines (Wave 11, Stream B1, production builds):
 * - marketing `/`: raw 942,873 B / brotli 241,663 B modern
 *   (1,055,467 B raw / 276,821 B brotli including the noModule
 *   polyfill). The three shared chunks (464,972 + 228,082 +
 *   169,445 B raw) are framework/runtime + shared UI (React,
 *   React-DOM, Next client runtime, sonner, Radix, next-themes) —
 *   page code is the small remainder. The 250 kB budget is met
 *   today, but only just; see the PRF-007 working paper for the
 *   per-chunk table.
 * - dashboard `/sign-in`: measured in the same pass; see the
 *   working paper (it is over its 300 kB budget — recorded as
 *   PARTIAL, not faked).
 */
import {
  brotliCompressSync,
  gzipSync,
  constants as zlibConstants,
} from "node:zlib"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

export const DEFAULT_BUDGETS_KB = {
  "apps/marketing:/": 250,
  "apps/dashboard:/sign-in": 300,
}

/** Extract same-origin chunk script URLs from page HTML. */
export function extractChunkScripts(html) {
  const scripts = []
  for (const m of html.matchAll(
    /<script([^>]*)src="(\/_next\/static\/chunks\/[^"]*\.js)"[^>]*>/g
  )) {
    scripts.push({
      src: m[2],
      file: m[2].split("/").pop(),
      noModule: /noModule/.test(m[1]) || /noModule/.test(m[0]),
    })
  }
  // Dedupe (the same chunk can be referenced twice in one document).
  return [...new Map(scripts.map((s) => [s.src, s])).values()]
}

/**
 * Sum first-load JS for a page's HTML against a built app's chunk
 * directory (`.next/static/chunks`). Returns per-script sizes plus
 * totals; `totalBrotliModern` excludes `noModule` scripts.
 */
export function measureFirstLoad(html, chunksDir) {
  const scripts = extractChunkScripts(html).map((s) => {
    const filePath = path.join(chunksDir, s.file)
    if (!existsSync(filePath)) {
      throw new Error(`chunk not found in build output: ${s.file}`)
    }
    const bytes = readFileSync(filePath)
    return {
      ...s,
      raw: bytes.length,
      gzip: gzipSync(bytes, { level: 9 }).length,
      brotli: brotliCompressSync(bytes, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
      }).length,
    }
  })
  const sum = (key, onlyModern) =>
    scripts
      .filter((s) => !onlyModern || !s.noModule)
      .reduce((acc, s) => acc + s[key], 0)
  return {
    scripts,
    totalRaw: sum("raw", false),
    totalRawModern: sum("raw", true),
    totalBrotli: sum("brotli", false),
    totalBrotliModern: sum("brotli", true),
  }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1]
      i++
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const app = args.app
  const budgetKb = Number(
    args.budget ?? DEFAULT_BUDGETS_KB[`${app}:${args.path ?? "/"}`] ?? 250
  )
  if (!app) {
    console.error(
      "usage: check-bundle-budget.mjs --app apps/<name> (--url <page-url> | --html <file>) [--budget <kB>]"
    )
    process.exit(1)
  }
  let html
  if (args.url) {
    const res = await fetch(args.url)
    if (!res.ok) throw new Error(`GET ${args.url} -> ${res.status}`)
    html = await res.text()
  } else if (args.html) {
    html = readFileSync(args.html, "utf8")
  } else {
    console.error("need --url or --html")
    process.exit(1)
  }
  const chunksDir = path.join(app, ".next/static/chunks")
  const result = measureFirstLoad(html, chunksDir)
  const kb = (n) => (n / 1024).toFixed(1)
  console.log(`first-load JS for ${args.url ?? args.html} (app: ${app})`)
  console.log(
    `${"chunk".padEnd(32)} ${"raw".padStart(8)} ${"gzip".padStart(8)} ${"brotli".padStart(8)}`
  )
  for (const s of result.scripts) {
    console.log(
      `${s.file.padEnd(32)} ${String(s.raw).padStart(8)} ${String(s.gzip).padStart(8)} ${String(s.brotli).padStart(8)}${s.noModule ? "  noModule" : ""}`
    )
  }
  console.log(
    `TOTAL modern (excl. noModule): raw ${kb(result.totalRawModern)} kB, brotli ${kb(result.totalBrotliModern)} kB`
  )
  console.log(
    `TOTAL incl. polyfill: raw ${kb(result.totalRaw)} kB, brotli ${kb(result.totalBrotli)} kB`
  )
  console.log(`budget: ${budgetKb} kB brotli (modern)`)
  if (result.totalBrotliModern > budgetKb * 1024) {
    console.error(
      `OVER BUDGET by ${kb(result.totalBrotliModern - budgetKb * 1024)} kB brotli`
    )
    process.exit(1)
  }
  console.log("within budget")
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname)
if (isMain) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
