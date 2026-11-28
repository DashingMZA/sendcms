#!/usr/bin/env python3
"""Env recount #2 (DOC-004): env vars referenced in code vs listed in
.env.example. Prints both directions of the gap.

Extended 2026-11-28 (Phase 17 findings fix, DOC-055):
- also matches `envInt("…")` reads (services/email-worker/src/worker.ts
  reads PORT / WORKER_PORT / WORKER_POLL_INTERVAL_MS /
  WORKER_POLL_TIMEOUT_MS that way; the old script was blind to them
  and undercounted referenced vars by one).
- strips // and /* */ comments before scanning: a comment can fake an
  env read — the BIL-051 note "zero process.env.GUMROAD reads" in
  packages/modules/billing/src/registry.ts counted bare GUMROAD as
  referenced until comments were stripped.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # repo root (this script lives in scripts/)
SKIP = {"node_modules", ".next", ".turbo", "generated", ".git"}


def strip_comments(text: str) -> str:
    """Remove // and /* */ comments, respecting '...' "..." `...`
    strings (and ${ } code spans inside template literals). Newlines
    inside block comments are kept so line numbers survive.
    Known limits: a // inside a regex literal (e.g. /https?:\\/\\//)
    is treated as a comment start, and a } closing a nested object
    literal inside a ${ } span is treated as the span end. Neither
    pattern holds an env read in this repo."""
    out = []
    i, n = 0, len(text)
    mode = "code"  # code | sq | dq | bt | line | block
    stack = []  # return modes for ${ } spans inside template literals
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if mode == "code":
            if c == "/" and nxt == "/":
                mode = "line"
                i += 2
                continue
            if c == "/" and nxt == "*":
                mode = "block"
                i += 2
                continue
            if c == "'":
                mode = "sq"
                out.append(c)
                i += 1
                continue
            if c == '"':
                mode = "dq"
                out.append(c)
                i += 1
                continue
            if c == "`":
                mode = "bt"
                out.append(c)
                i += 1
                continue
            if c == "}" and stack:
                mode = stack.pop()
                out.append(c)
                i += 1
                continue
            out.append(c)
            i += 1
            continue
        if mode == "line":
            if c == "\n":
                mode = "code"
                out.append(c)
            i += 1
            continue
        if mode == "block":
            if c == "*" and nxt == "/":
                mode = "code"
                i += 2
                continue
            if c == "\n":
                out.append(c)
            i += 1
            continue
        if mode in ("sq", "dq"):
            out.append(c)
            if c == "\\":
                if i + 1 < n:
                    out.append(text[i + 1])
                    i += 2
                    continue
                i += 1
                continue
            if (mode == "sq" and c == "'") or (mode == "dq" and c == '"'):
                mode = "code"
            i += 1
            continue
        # mode == "bt" (template literal)
        out.append(c)
        if c == "\\":
            if i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            i += 1
            continue
        if c == "`":
            mode = "code"
            i += 1
            continue
        if c == "$" and nxt == "{":
            stack.append("bt")
            mode = "code"
            out.append(nxt)
            i += 2
            continue
        i += 1
    return "".join(out)


# --- listed in .env.example --------------------------------------------
listed = set()
for line in (ROOT / ".env.example").read_text().splitlines():
    m = re.match(r"#?\s*([A-Z][A-Z0-9_]*)\s*=", line)
    if m:
        listed.add(m.group(1))

# --- referenced in code -------------------------------------------------
referenced = set()
for base in ["apps", "packages", "services", "scripts"]:
    for f in (ROOT / base).rglob("*"):
        if not f.is_file() or f.suffix not in {".ts", ".tsx", ".mts", ".js", ".mjs"}:
            continue
        if f.name == "cloudflare-env.d.ts":
            continue  # generated workerd types — env.X there are bindings, not app vars
        if SKIP & set(f.parts):
            continue
        t = strip_comments(f.read_text(errors="ignore"))
        for m in re.finditer(r"process\.env\.([A-Z][A-Z0-9_]*)", t):
            referenced.add(m.group(1))
        for m in re.finditer(r"process\.env\[['\"]([A-Z][A-Z0-9_]*)['\"]\]", t):
            referenced.add(m.group(1))
        # Services take an `env` param (NodeJS.ProcessEnv) and read
        # env.VAR off it — same variables, different access shape.
        for m in re.finditer(r"\benv\.([A-Z][A-Z0-9_]*)", t):
            referenced.add(m.group(1))
        for m in re.finditer(r"\benv\[['\"]([A-Z][A-Z0-9_]*)['\"]\]", t):
            referenced.add(m.group(1))
        # Integer env reads: the email worker reads its numeric vars
        # via envInt("…", fallback) — same variables, another shape.
        for m in re.finditer(r"""\benvInt\(["']([A-Z][A-Z0-9_]*)["']""", t):
            referenced.add(m.group(1))
# .env.example is also the source for vars only referenced in config
# files (yaml/jsonc/mjs) — scan those too, but only for UPPER names
# that look like env vars (avoid NEXT_PUBLIC_* build args duplicates).
for f in list((ROOT).glob("*.yml")) + list((ROOT).glob("*.yaml")) + list((ROOT / "apps").rglob("wrangler.jsonc")):
    t = f.read_text(errors="ignore")
    for m in re.finditer(r"\b([A-Z][A-Z0-9_]{2,})\b", t):
        if m.group(1) in listed:
            referenced.add(m.group(1))

print(f"listed in .env.example: {len(listed)}")
print(f"referenced in code:     {len(referenced)}")
# Exclusions (documented, not gaps): Next.js/Node built-ins, the
# NEXT_PUBLIC_ prefix use (not a variable), and i18n script-only
# tooling flags (never read by app runtime).
BUILTINS = {"NEXT_RUNTIME", "NODE_ENV", "NEXT_PUBLIC_"}
SCRIPT_ONLY = {"SENDCMS_I18N_DUMP_USED", "SENDCMS_I18N_LOCALES_DIR", "SENDCMS_I18N_REPO_ROOT"}
ref = referenced - BUILTINS - SCRIPT_ONLY
print(f"referenced (app vars, after exclusions): {len(ref)}")
print(f"referenced NOT listed:  {sorted(ref - listed)}")
print(f"listed NOT referenced:  {sorted(listed - ref)}")
print(f"excluded as built-ins/prefix: {sorted(referenced & BUILTINS)}")
print(f"excluded as script-only tooling: {sorted(referenced & SCRIPT_ONLY)}")
