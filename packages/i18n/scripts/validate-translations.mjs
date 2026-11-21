// packages/i18n/scripts/validate-translations.mjs
// Validate the admin translation files. No dependencies.
//
// Checks:
//   1. Every JSON file under locales/{en,ur} parses.
//   2. en and ur have identical key sets per domain file (missing/extra
//      keys fail the run).
//   3. Translation completeness per locale; the 8 coming-soon locales are
//      reported as "not started" WITHOUT failing.
//
// Exits non-zero ONLY when en or ur is incomplete or any JSON is invalid.
// Usage: node scripts/validate-translations.mjs [--check]

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const localesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "locales"
)

const SOURCE_LOCALE = "en"
const REQUIRED_LOCALES = ["en", "ur"]
const ALL_LOCALES = ["en", "ur", "es", "ar", "fr", "de", "hi", "bn", "id", "it"]

async function listJsonFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(path.join(dir, entry.name), rel)))
    } else if (entry.name.endsWith(".json")) {
      files.push(rel)
    }
  }
  return files.sort()
}

async function readMessages(locale, rel) {
  const raw = await readFile(path.join(localesDir, locale, rel), "utf8")
  return JSON.parse(raw)
}

const failures = []
const report = []

// 1 + 2. Source locale first, then the required locales must match it key-for-key.
const sourceFiles = await listJsonFiles(path.join(localesDir, SOURCE_LOCALE))
if (sourceFiles.length === 0) {
  failures.push(`no translation files found under locales/${SOURCE_LOCALE}`)
}

const sourceMessages = new Map()
for (const rel of sourceFiles) {
  try {
    sourceMessages.set(rel, await readMessages(SOURCE_LOCALE, rel))
  } catch (err) {
    failures.push(
      `locales/${SOURCE_LOCALE}/${rel}: invalid JSON (${err.message})`
    )
  }
}

for (const locale of REQUIRED_LOCALES) {
  if (locale === SOURCE_LOCALE) continue
  const files = await listJsonFiles(path.join(localesDir, locale))
  const fileSet = new Set(files)
  for (const rel of sourceFiles) {
    if (!fileSet.has(rel)) {
      failures.push(`locales/${locale}/${rel}: file missing`)
      continue
    }
    let messages
    try {
      messages = await readMessages(locale, rel)
    } catch (err) {
      failures.push(`locales/${locale}/${rel}: invalid JSON (${err.message})`)
      continue
    }
    const sourceKeys = Object.keys(sourceMessages.get(rel) ?? {})
    const keys = Object.keys(messages)
    const missing = sourceKeys.filter((k) => !keys.includes(k))
    const extra = keys.filter((k) => !sourceKeys.includes(k))
    if (missing.length > 0) {
      failures.push(
        `locales/${locale}/${rel}: missing keys: ${missing.join(", ")}`
      )
    }
    if (extra.length > 0) {
      failures.push(`locales/${locale}/${rel}: extra keys: ${extra.join(", ")}`)
    }
  }
  // Files present in the locale but not in the source are also a mismatch.
  for (const rel of files) {
    if (!sourceMessages.has(rel)) {
      failures.push(
        `locales/${locale}/${rel}: no matching source file in locales/${SOURCE_LOCALE}`
      )
    }
  }
}

// 3. Completeness per locale (informational for coming-soon locales).
const sourceKeyCount = [...sourceMessages.values()].reduce(
  (sum, messages) => sum + Object.keys(messages).length,
  0
)
for (const locale of ALL_LOCALES) {
  const files = await listJsonFiles(path.join(localesDir, locale))
  if (files.length === 0) {
    report.push(`  ${locale}: not started (0/${sourceFiles.length} files)`)
    continue
  }
  let keys = 0
  let invalid = 0
  for (const rel of files) {
    try {
      keys += Object.keys(await readMessages(locale, rel)).length
    } catch {
      invalid += 1
    }
  }
  const pct =
    sourceKeyCount === 0 ? 100 : Math.round((keys / sourceKeyCount) * 100)
  const flag = REQUIRED_LOCALES.includes(locale) ? "" : " (coming-soon)"
  report.push(
    `  ${locale}: ${files.length}/${sourceFiles.length} files, ${keys}/${sourceKeyCount} keys (${pct}%)${invalid > 0 ? `, ${invalid} invalid` : ""}${flag}`
  )
}

console.log("Translation validation")
console.log(
  `Source locale: ${SOURCE_LOCALE} — ${sourceFiles.length} files, ${sourceKeyCount} keys`
)
console.log("Completeness:")
for (const line of report) console.log(line)

if (failures.length > 0) {
  console.log("\nFailures:")
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log("\n✓ en and ur are complete and in sync.")
