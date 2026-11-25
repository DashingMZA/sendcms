// packages/i18n/scripts/check-code-usage.mjs
// Code-usage check for translations (I18N-001 / ADM-096 / ADM-121 /
// ADM-122 / ADM-031 / ADM-003 regression test).
//
// The parity validator (`validate-translations.mjs`) can only see keys
// that exist in `en`: a key used in code but absent from BOTH locale
// files passes parity while the UI renders `[missing: key]`. This
// script closes that gap: it extracts every translation key actually
// used by `apps/admin` + `apps/dashboard` and asserts each one exists
// in the `en` locale file of its domain (parity then guarantees `ur`).
//
// How keys are resolved (mirrors the Phase 6 coverage scanner):
//   - Direct calls: `t("key")` / `t("key", { vars })`, attributed to
//     the translator binding active at that line (`useTranslation` /
//     `getTranslator`, including `t: alias` renames).
//   - Key maps: `t(STATUS_KEYS[x])` resolves every value of the
//     in-file object literal (unquoted keys included — the scanner
//     bug behind withdrawn finding I18N-011 is NOT repeated here).
//   - Ternaries: `t(cond ? "a" : "b")` and `const k = cond ? "a" : "b"`
//     followed by `t(k)` resolve to all of their string literals.
//   - Template literals: `t(`prefix${v}…`)` over an in-file string
//     array (e.g. REQUEST_STATUSES) is evaluated per element; when no
//     array resolves, an `as "literal"` cast supplies the
//     representative key.
//   - Destructured key props: `t(labelKey)` / `t(periodKey)` resolve
//     to every `labelKey: "…"` / `periodKey="…"` value in the file and
//     across the apps tree, plus `return "…"` values of functions
//     referenced as `periodKey={fn(…)}`.
//   - Dynamic domains: `useTranslation(domain)` (a prop) resolves to
//     every `domain="…"` value passed to that component across the
//     apps tree, plus the prop's default value; the key must exist in
//     every traced domain.
//   - Prop-drilled `t`: a `t("…")` call with no binding active at its
//     line falls back to the file's domain set (the key must exist in
//     at least one of them).
//
// Usages the script cannot resolve are printed as warnings (not
// failures) and listed, never silently dropped. A usage that resolves
// to a key missing from its domain file is a failure (exit 1).
//
// Usage: node scripts/check-code-usage.mjs
// Test seam: SENDCMS_I18N_REPO_ROOT overrides the repo root
// (derived from this file's location otherwise).

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot =
  process.env.SENDCMS_I18N_REPO_ROOT ?? path.resolve(scriptDir, "../../..")
const localesDir = path.join(repoRoot, "packages/i18n/locales")
const appDirs = ["apps/admin", "apps/dashboard"]

const failures = []
const warnings = []
const usedKeys = new Set()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length
}

async function listSourceFiles(dir, prefix = "") {
  const entries = await readdir(path.join(repoRoot, dir, prefix), {
    withFileTypes: true,
  }).catch(() => [])
  const files = []
  for (const entry of entries) {
    if (entry.name === "node_modules") continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(dir, rel)))
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.includes(".test.")
    ) {
      files.push(`${dir}/${rel}`)
    }
  }
  return files
}

function quotedStrings(text) {
  const out = []
  const re = /"([^"\\]*)"|'([^'\\]*)'/g
  let m
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2])
  return out
}

/** Find the index just past the `)` matching the `(` at `openIdx`. */
function scanParen(text, openIdx) {
  let depth = 0
  let i = openIdx
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      i += 1
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i += 1
        i += 1
      }
    } else if (ch === "`") {
      i += 1
      let interp = 0
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2
          continue
        }
        if (text[i] === "$" && text[i + 1] === "{") {
          interp += 1
          i += 2
          continue
        }
        if (interp > 0 && text[i] === "}") {
          interp -= 1
          i += 1
          continue
        }
        if (interp === 0 && text[i] === "`") break
        i += 1
      }
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

/** Extract the body of the `{...}` / `[...]` starting at `openIdx`. */
function scanBracket(text, openIdx) {
  const closeIdx = scanParen(text, openIdx)
  return closeIdx === -1 ? null : text.slice(openIdx + 1, closeIdx)
}

/**
 * String literals in the *value positions* of a ternary expression
 * (`c1 ? "a" : c2 ? "b" : "c"` → `a`, `b`, `c`). Condition literals
 * (e.g. `mode === "BYOK"`, `warning === "no-domain"`) are values
 * being compared, not translation keys, so they are never collected.
 * String-aware: `?.` and `??` are not ternaries, and `?`/`:` inside
 * a string literal or an object literal does not count.
 */
function branchLiterals(text) {
  const keys = []
  let depth = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      i += 1
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i += 1
        i += 1
      }
    } else if (ch === "`") {
      i += 1
      let interp = 0
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2
          continue
        }
        if (text[i] === "$" && text[i + 1] === "{") {
          interp += 1
          i += 2
          continue
        }
        if (interp > 0 && text[i] === "}") {
          interp -= 1
          i += 1
          continue
        }
        if (interp === 0 && text[i] === "`") break
        i += 1
      }
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1
    } else if (
      (ch === "?" || ch === ":") &&
      depth === 0 &&
      text[i + 1] !== "?" &&
      text[i + 1] !== "."
    ) {
      // Value position: a string literal right after the ? / : is a key.
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j += 1
      if (text[j] === '"' || text[j] === "'") {
        const quote = text[j]
        let k = j + 1
        let value = ""
        while (k < text.length && text[k] !== quote) {
          if (text[k] === "\\") {
            value += text[k]
            k += 1
          }
          value += text[k]
          k += 1
        }
        keys.push(value)
        i = k + 1
        continue
      }
    }
    i += 1
  }
  // No ternary value positions (e.g. `x ?? "fallback"`): the literal
  // is the fallback value, so keep it.
  if (keys.length === 0) return quotedStrings(text)
  return keys
}

// ---------------------------------------------------------------------------
// Domain lists (parsed from packages/i18n/src/load.ts, not hardcoded)
// ---------------------------------------------------------------------------

const loadTs = await readFile(
  path.join(repoRoot, "packages/i18n/src/load.ts"),
  "utf8"
)

function parseDomainList(name) {
  const m = loadTs.match(new RegExp(`${name} = \\[([\\s\\S]*?)\\] as const`))
  if (!m) return []
  return quotedStrings(m[1])
}

const SHARED_DOMAINS = parseDomainList("SHARED_DOMAINS")
const ADMIN_DOMAINS = parseDomainList("ADMIN_DOMAINS")
const DASHBOARD_DOMAINS = parseDomainList("DASHBOARD_DOMAINS")

function domainFile(app, domain) {
  // App domains take precedence over shared domains: `security`,
  // `settings`, and `forms` exist in BOTH the shared set and an app
  // set, and the apps always mean their own file (this mirrors
  // apps/*/lib/i18n.ts, which checks isAdminDomain/isDashboardDomain
  // first and only then falls back to the shared file).
  if (app === "apps/admin" && ADMIN_DOMAINS.includes(domain)) {
    return `admin/${domain}.json`
  }
  if (app === "apps/dashboard" && DASHBOARD_DOMAINS.includes(domain)) {
    return `dashboard/${domain}.json`
  }
  if (SHARED_DOMAINS.includes(domain)) return `${domain}.json`
  return null
}

// Defined keys per domain file (en is the source of truth).
const definedKeys = new Map()
async function loadDefined(rel) {
  if (definedKeys.has(rel)) return definedKeys.get(rel)
  try {
    const messages = JSON.parse(
      await readFile(path.join(localesDir, "en", rel), "utf8")
    )
    const keys = new Set(Object.keys(messages))
    definedKeys.set(rel, keys)
    return keys
  } catch {
    definedKeys.set(rel, null)
    return null
  }
}

// ---------------------------------------------------------------------------
// Load all app sources (also needed for cross-file prop tracing)
// ---------------------------------------------------------------------------

const allFiles = []
for (const appDir of appDirs) {
  allFiles.push(...(await listSourceFiles(appDir)))
}
const sources = new Map()
for (const file of allFiles) {
  sources.set(file, await readFile(path.join(repoRoot, file), "utf8"))
}
const allText = [...sources.entries()]
  .map(([file, text]) => `\n// __file: ${file}\n${text}`)
  .join("\n")

// Cross-file key maps / string arrays: `export const NAME = { … }`
// defined in one file and imported by others (e.g.
// SUBMISSION_STATUS_LABEL_KEYS in submission-status-badge.tsx).
// Keyed by name; a name defined in more than one file is ambiguous
// and is never used as a fallback.
const globalMaps = new Map()
const globalArrays = new Map()
for (const [file, text] of sources) {
  const mapRe =
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?=\s*\{/g
  let gm
  while ((gm = mapRe.exec(text)) !== null) {
    const openIdx = text.indexOf("{", gm.index)
    const body = scanBracket(text, openIdx)
    if (body === null) continue
    const values = []
    const valueRe = /:\s*"([^"]+)"|:\s*'([^']+)'/g
    let vm
    while ((vm = valueRe.exec(body)) !== null) values.push(vm[1] ?? vm[2])
    if (values.length === 0) continue
    const entry = globalMaps.get(gm[1]) ?? {
      values: new Set(),
      files: new Set(),
    }
    for (const v of values) entry.values.add(v)
    entry.files.add(file)
    globalMaps.set(gm[1], entry)
  }
  const arrRe = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g
  let ga
  while ((ga = arrRe.exec(text)) !== null) {
    const openIdx = text.indexOf("[", ga.index)
    const body = scanBracket(text, openIdx)
    if (body === null) continue
    const values = quotedStrings(body)
    if (values.length === 0) continue
    const entry = globalArrays.get(ga[1]) ?? {
      values: new Set(),
      files: new Set(),
    }
    for (const v of values) entry.values.add(v)
    entry.files.add(file)
    globalArrays.set(ga[1], entry)
  }
}

function findPropLiterals(propName) {
  // JSX attribute form: propName="literal" (any component, any file).
  const values = new Set()
  const re = new RegExp(`\\b${propName}\\s*=\\s*"([^"]+)"`, "g")
  let m
  while ((m = re.exec(allText)) !== null) values.add(m[1])
  return values
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

const USE_TRANSLATION_RE =
  /(?:const|let|var)\s*\{\s*t\s*(?::\s*([A-Za-z_$][\w$]*))?\s*\}\s*=\s*(?:await\s+)?useTranslation\(\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*\)/g
const GET_TRANSLATOR_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?getTranslator\(\s*[^,]+,\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*\)/g

for (const [file, text] of sources) {
  const app = file.startsWith("apps/admin") ? "apps/admin" : "apps/dashboard"

  // --- Bindings ---------------------------------------------------------
  const bindings = []
  for (const re of [USE_TRANSLATION_RE, GET_TRANSLATOR_RE]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const varName = m[1] ?? "t"
      const literal = m[2] ?? m[3] ?? null
      const varArg = m[4] ?? null
      bindings.push({
        varName,
        literal,
        varArg,
        line: lineOf(text, m.index),
      })
    }
  }
  if (bindings.length === 0) continue

  // Component names exported from this file (for dynamic-domain tracing).
  const componentNames = new Set()
  const exportRe = /export\s+(?:function|const)\s+([A-Za-z_$][\w$]*)/g
  let em
  while ((em = exportRe.exec(text)) !== null) {
    componentNames.add(em[1])
  }

  // In-file string arrays: const NAME = ["A", "B"] as const
  const arrays = new Map()
  const arrayRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g
  let am
  while ((am = arrayRe.exec(text)) !== null) {
    const openIdx = text.indexOf("[", am.index)
    const body = scanBracket(text, openIdx)
    if (body !== null) arrays.set(am[1], quotedStrings(body))
  }

  // In-file key maps: const NAME = { key: "value", ... }
  const maps = new Map()
  const mapRe = /const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?=\s*\{/g
  let mm
  while ((mm = mapRe.exec(text)) !== null) {
    const openIdx = text.indexOf("{", mm.index)
    const body = scanBracket(text, openIdx)
    if (body === null) continue
    const values = []
    const valueRe = /:\s*"([^"]+)"|:\s*'([^']+)'/g
    let vm
    while ((vm = valueRe.exec(body)) !== null) values.push(vm[1] ?? vm[2])
    if (values.length > 0) maps.set(mm[1], values)
  }

  // Ternary-assigned key vars: const k = cond ? "a" : "b" (the
  // trailing semicolon is optional in this codebase, so the statement
  // is scanned, not regexed, up to `;` or the next statement).
  const ternaryVars = new Map()
  const declRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g
  let dm
  while ((dm = declRe.exec(text)) !== null) {
    let i = declRe.lastIndex
    let depth = 0
    let end = -1
    while (i < text.length) {
      const ch = text[i]
      if (ch === '"' || ch === "'") {
        const quote = ch
        i += 1
        while (i < text.length && text[i] !== quote) {
          if (text[i] === "\\") i += 1
          i += 1
        }
      } else if (ch === "`") {
        i += 1
        while (i < text.length && text[i] !== "`") {
          if (text[i] === "\\") i += 1
          i += 1
        }
      } else if (ch === "(" || ch === "[" || ch === "{") {
        depth += 1
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth -= 1
        if (depth < 0) {
          end = i
          break
        }
      } else if (ch === ";" && depth === 0) {
        end = i
        break
      } else if (ch === "\n" && depth === 0) {
        const rest = text.slice(i + 1)
        if (/^\s*(const |let |var |return |}|\))/.test(rest)) {
          end = i
          break
        }
      }
      i += 1
    }
    if (end === -1) continue
    const span = text.slice(declRe.lastIndex, end)
    if (span.includes("?") && span.includes(":")) {
      const lits = branchLiterals(span)
      if (lits.length > 0) ternaryVars.set(dm[1], lits)
    }
  }

  // Function return literals (for prop-passed key vars like
  // periodKey={periodLabelKey(meter)}).
  const fnReturns = new Map()
  const fnRe = /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)[^{]*\{/g
  let fm
  while ((fm = fnRe.exec(text)) !== null) {
    const openIdx = text.indexOf("{", fm.index)
    const body = scanBracket(text, openIdx)
    if (body === null) continue
    const returns = []
    const retRe = /return\s+"([^"]+)"|return\s+'([^']+)'/g
    let rm
    while ((rm = retRe.exec(body)) !== null) returns.push(rm[1] ?? rm[2])
    if (returns.length > 0) fnReturns.set(fm[1], returns)
  }

  // Resolve a dynamic domain (a `domain` prop) to the literal domains
  // the component is rendered with.
  function tracedDomains(binding) {
    const found = new Set()
    const defaultRe = new RegExp(`\\b${binding.varArg}\\s*=\\s*"([^"]+)"`)
    const dm = defaultRe.exec(text)
    if (dm) found.add(dm[1])
    for (const name of componentNames) {
      const usageRe = new RegExp(
        `<${name}\\b[\\s\\S]{0,800}?\\bdomain\\s*=\\s*"([^"]+)"`,
        "g"
      )
      let um
      while ((um = usageRe.exec(allText)) !== null) found.add(um[1])
    }
    return [...found]
  }

  // All domains bound in this file (literal + traced dynamic).
  const fileDomains = new Set()
  for (const b of bindings) {
    if (b.literal) fileDomains.add(b.literal)
    else if (b.varArg) {
      for (const d of tracedDomains(b)) fileDomains.add(d)
    }
  }

  // --- Template-literal evaluation --------------------------------------
  function evalTemplateExpr(expr, value) {
    // Supports the shapes used in the apps: v, v.charAt(0),
    // v.slice(1), v.slice(1).toLowerCase(), v.toLowerCase(),
    // v.toUpperCase(), and chains of those.
    let current = value
    let rest = expr.trim()
    const varMatch = rest.match(/^([A-Za-z_$][\w$]*)/)
    if (!varMatch) return null
    rest = rest.slice(varMatch[1].length)
    while (rest.length > 0) {
      const call = rest.match(
        /^\.(charAt|slice|toLowerCase|toUpperCase)\(([^)]*)\)/
      )
      if (!call) return null
      const [, method, args] = call
      if (method === "charAt") {
        current = current.charAt(Number(args.trim()) || 0)
      } else if (method === "slice") {
        const parts = args.split(",").map((a) => Number(a.trim()))
        current =
          parts.length > 1
            ? current.slice(parts[0], parts[1])
            : current.slice(parts[0])
      } else if (method === "toLowerCase") {
        current = current.toLowerCase()
      } else if (method === "toUpperCase") {
        current = current.toUpperCase()
      }
      rest = rest.slice(call[0].length)
    }
    return current
  }

  function resolveTemplate(arg, restAfterTemplate) {
    // arg is a backtick literal: `lit${expr}lit${expr}lit`
    const inner = arg.slice(1, -1)
    const parts = []
    const exprs = []
    let buf = ""
    let i = 0
    while (i < inner.length) {
      if (inner[i] === "$" && inner[i + 1] === "{") {
        parts.push(buf)
        buf = ""
        let depth = 1
        let j = i + 2
        while (j < inner.length && depth > 0) {
          if (inner[j] === "{") depth += 1
          else if (inner[j] === "}") depth -= 1
          j += 1
        }
        exprs.push(inner.slice(i + 2, j - 1))
        i = j
      } else {
        buf += inner[i]
        i += 1
      }
    }
    parts.push(buf)
    if (exprs.length === 0) return { keys: [inner] }

    // Find the iterated array: X.map((v) => ...) enclosing the call,
    // or any in-file string array whose name matches an expr variable.
    const varNames = exprs.map(
      (e) => e.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1]
    )
    const candidates = []
    for (const [name, values] of arrays) {
      if (varNames.includes(name)) candidates.push(values)
    }
    // `.map((v) =>` over a named array: the callback param is the var.
    for (const varName of new Set(varNames)) {
      if (!varName) continue
      const mapRe2 = new RegExp(
        `([A-Za-z_$][\\w$]*)\\.map\\(\\s*\\(?\\s*${varName}\\b`
      )
      const mapMatch = mapRe2.exec(text)
      if (mapMatch && arrays.has(mapMatch[1])) {
        candidates.push(arrays.get(mapMatch[1]))
      }
      // `row.status` style: the iterated values are the same enum as
      // an in-file array of the same template shape — reuse any
      // in-file array whose elements evaluate to keys that exist is
      // NOT sound, so fall through to the cast below instead.
    }
    const values = candidates[0]
    if (values) {
      const keys = []
      for (const value of values) {
        let out = parts[0]
        let ok = true
        for (let k = 0; k < exprs.length; k++) {
          const evaluated = evalTemplateExpr(exprs[k], value)
          if (evaluated === null) {
            ok = false
            break
          }
          out += evaluated + parts[k + 1]
        }
        if (ok) keys.push(out)
      }
      if (keys.length > 0) return { keys }
    }
    // Fallback: an `as "literal"` cast names one key of the set.
    const cast = restAfterTemplate.match(/as\s+"([^"]+)"/)
    if (cast) return { keys: [cast[1]], viaCast: true }
    return { keys: [], unresolvable: "template literal" }
  }

  function resolveIdentifierArg(name) {
    if (ternaryVars.has(name)) return { keys: ternaryVars.get(name) }
    if (maps.has(name)) return { keys: maps.get(name) }
    const keys = new Set()
    // Intermediate map lookup: `const labelKey = STATUS_LABEL_KEYS[x]`
    // followed by `t(labelKey)`. The map's values are the used keys
    // (the Phase 6 scanner missed this shape; the email-jobs table's
    // status labels proved it — see tests/wave7-stream-a.test.ts).
    const lookupRe = new RegExp(
      `(?:const|let|var)\\s+${name}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\[`
    )
    const lookup = lookupRe.exec(text)
    if (lookup) {
      const mapName = lookup[1]
      if (maps.has(mapName)) {
        for (const v of maps.get(mapName)) keys.add(v)
      } else if (
        globalMaps.has(mapName) &&
        globalMaps.get(mapName).files.size === 1
      ) {
        for (const v of globalMaps.get(mapName).values) keys.add(v)
      }
    }
    const propRe = new RegExp(`\\b${name}\\s*[:=]\\s*"([^"]+)"`, "g")
    let pm
    while ((pm = propRe.exec(text)) !== null) keys.add(pm[1])
    for (const v of findPropLiterals(name)) keys.add(v)
    // `name={fn(...)}` across the tree: the function's return literals.
    const fnRefRe = new RegExp(
      `\\b${name}\\s*=\\s*\\{\\s*([A-Za-z_$][\\w$]*)\\s*\\(`,
      "g"
    )
    while ((pm = fnRefRe.exec(allText)) !== null) {
      const fnName = pm[1]
      if (fnReturns.has(fnName)) {
        for (const r of fnReturns.get(fnName)) keys.add(r)
      }
      // The referenced function may live in another file: search all
      // sources for its body and collect its `return "…"` literals.
      for (const [, otherText] of sources) {
        const fnDecl = new RegExp(
          `function\\s+${fnName}\\s*\\([^)]*\\)[^{]*\\{`
        ).exec(otherText)
        if (!fnDecl) continue
        const body = scanBracket(
          otherText,
          otherText.indexOf("{", fnDecl.index)
        )
        if (body === null) continue
        const retRe2 = /return\s+"([^"]+)"|return\s+'([^']+)'/g
        let rm2
        while ((rm2 = retRe2.exec(body)) !== null) {
          keys.add(rm2[1] ?? rm2[2])
        }
      }
    }
    if (keys.size > 0) return { keys: [...keys] }
    return { keys: [], unresolvable: `identifier ${name}` }
  }

  // --- Call sites ---------------------------------------------------------
  const varNames = [...new Set(bindings.map((b) => b.varName))]
  for (const varName of varNames) {
    const callRe = new RegExp(`\\b${varName}\\s*\\(`, "g")
    let cm
    while ((cm = callRe.exec(text)) !== null) {
      const callLine = lineOf(text, cm.index)
      // Skip the binding's own RHS (useTranslation/getTranslator call).
      if (
        bindings.some(
          (b) =>
            b.varName === varName &&
            b.line === callLine &&
            /useTranslation|getTranslator/.test(
              text.slice(cm.index, cm.index + 40)
            )
        )
      ) {
        continue
      }
      const openIdx = text.indexOf("(", cm.index)
      const closeIdx = scanParen(text, openIdx)
      if (closeIdx === -1) {
        warnings.push(
          `${file}:${callLine}: unresolvable call to ${varName} (unbalanced parens)`
        )
        continue
      }
      const arg = text.slice(openIdx + 1, closeIdx).trim()
      if (arg.length === 0) continue

      // Attribute domains: the binding active at this line, else the
      // file's domain set (prop-drilled `t`).
      const active = [...bindings]
        .filter((b) => b.varName === varName && b.line <= callLine)
        .sort((a, b) => b.line - a.line)[0]
      let domains = []
      let mode = "all"
      if (active) {
        if (active.literal) domains = [active.literal]
        else if (active.varArg) {
          domains = tracedDomains(active)
          if (domains.length === 0) {
            warnings.push(
              `${file}:${callLine}: cannot trace dynamic domain for ${varName} (useTranslation(${active.varArg}))`
            )
            continue
          }
        }
      } else {
        domains = [...fileDomains]
        mode = "any"
      }
      if (domains.length === 0) {
        warnings.push(`${file}:${callLine}: no domain for ${varName}() call`)
        continue
      }

      // Resolve the key(s) from the argument.
      let resolved
      const leading = arg.match(/^"([^"]*)"|^'([^']*)'/)
      if (leading) {
        // t("key") or t("key", { vars }) — the leading literal is the
        // key; anything after it is the vars object, whose own string
        // literals (fallbacks, em-dashes) are not keys.
        resolved = { keys: [leading[1] ?? leading[2]] }
      } else if (arg.startsWith("`")) {
        // The argument may be a bare template literal or a template
        // with an `as "literal"` cast after it — resolve just the
        // template part, then let the cast act as the fallback.
        let end = 1
        let interp = 0
        while (end < arg.length) {
          if (arg[end] === "\\") {
            end += 2
            continue
          }
          if (arg[end] === "$" && arg[end + 1] === "{") {
            interp += 1
            end += 2
            continue
          }
          if (interp > 0 && arg[end] === "}") {
            interp -= 1
            end += 1
            continue
          }
          if (interp === 0 && arg[end] === "`") break
          end += 1
        }
        const template = arg.slice(0, end + 1)
        const rest = arg.slice(end + 1)
        resolved = resolveTemplate(template, rest)
      } else if (arg.includes("?") && arg.includes(":")) {
        resolved = { keys: branchLiterals(arg) }
      } else {
        const mapCall = arg.match(/^([A-Za-z_$][\w$]*)\s*\[/)
        if (mapCall) {
          if (maps.has(mapCall[1])) {
            resolved = { keys: maps.get(mapCall[1]) }
          } else if (
            globalMaps.has(mapCall[1]) &&
            globalMaps.get(mapCall[1]).files.size === 1
          ) {
            resolved = {
              keys: [...globalMaps.get(mapCall[1]).values],
            }
          } else {
            resolved = { keys: [], unresolvable: `key map ${mapCall[1]}` }
          }
        } else {
          const ident = arg.match(/^([A-Za-z_$][\w$]*)$/)
          resolved = ident
            ? resolveIdentifierArg(ident[1])
            : { keys: quotedStrings(arg) }
        }
      }
      if (resolved.unresolvable) {
        warnings.push(
          `${file}:${callLine}: unresolvable ${resolved.unresolvable} in ${varName}(${arg.slice(0, 60)})`
        )
        continue
      }
      if (resolved.keys.length === 0) {
        warnings.push(
          `${file}:${callLine}: no keys resolved from ${varName}(${arg.slice(0, 60)})`
        )
        continue
      }

      for (const key of resolved.keys) {
        usedKeys.add(`${app}:${domains.join("+")}:${key}`)
        const checks = []
        for (const domain of domains) {
          const rel = domainFile(app, domain)
          if (rel === null) {
            warnings.push(
              `${file}:${callLine}: unknown domain "${domain}" for key "${key}"`
            )
            continue
          }
          const defined = await loadDefined(rel)
          if (defined === null) {
            failures.push(
              `${file}:${callLine}: domain file locales/en/${rel} is missing (key "${key}")`
            )
            continue
          }
          checks.push(defined.has(key))
        }
        const missing =
          mode === "all"
            ? checks.some((c) => !c)
            : checks.length > 0 && checks.every((c) => !c)
        if (missing) {
          failures.push(
            `${file}:${callLine}: key "${key}" used in domain(s) ${domains.join(", ")} but absent from locales/en/${domains
              .map((d) => domainFile(app, d))
              .join(", ")}`
          )
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log("Code-usage check")
console.log(`  files scanned: ${sources.size}`)
console.log(`  distinct used keys: ${usedKeys.size}`)
if (warnings.length > 0) {
  console.log(`  warnings (${warnings.length} unresolvable usages):`)
  for (const w of warnings) console.log(`  ~ ${w}`)
}
if (failures.length > 0) {
  console.log(`\nFailures (${failures.length}):`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log("  ✓ every key used in code exists in its en locale file.")

// Debug seam: SENDCMS_I18N_DUMP_USED=<path> writes every resolved
// (domain, key) pair as JSON, for diffing against the Phase 6 scanner.
if (process.env.SENDCMS_I18N_DUMP_USED) {
  const { writeFileSync } = await import("node:fs")
  const pairs = []
  for (const entry of usedKeys) {
    const [app, domains, key] = entry.split(":")
    for (const domain of domains.split("+")) pairs.push({ app, domain, key })
  }
  pairs.sort((a, b) =>
    `${a.app}/${a.domain}:${a.key}`.localeCompare(
      `${b.app}/${b.domain}:${b.key}`
    )
  )
  writeFileSync(
    process.env.SENDCMS_I18N_DUMP_USED,
    JSON.stringify(pairs, null, 2)
  )
}
