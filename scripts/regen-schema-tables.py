#!/usr/bin/env python3
"""Regenerate the Existing Enums / Existing Models tables in
.agents/skills/project-guidelines/references/database-schema.md
from packages/database/prisma/schema.prisma (source of truth).

Usage: python3 scripts/regen-schema-tables.py  → prints the two
markdown tables; splice them into the doc between the
"## Existing Enums" heading and the "## Anti-Patterns" heading.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "packages/database/prisma/schema.prisma"
text = SCHEMA.read_text()

# --- parse blocks -------------------------------------------------------
blocks = {}  # (kind, name) -> body lines
cur = None
for line in text.splitlines():
    m = re.match(r"^(model|enum)\s+(\w+)\s*\{", line)
    if m:
        cur = (m.group(1), m.group(2))
        blocks[cur] = []
        continue
    if cur and line.strip() == "}":
        cur = None
        continue
    if cur:
        blocks[cur].append(line)

models = {n: b for (k, n), b in blocks.items() if k == "model"}
enums = {n: b for (k, n), b in blocks.items() if k == "enum"}

# --- enums table --------------------------------------------------------
enum_used_by: dict[str, list[str]] = {e: [] for e in enums}
for mname, body in models.items():
    for line in body:
        fm = re.match(r"\s+(\w+)\s+(\w+)(\[\]|\?)?(?:\s|$)", line)
        if fm and fm.group(2) in enums:
            enum_used_by[fm.group(2)].append(f"{mname}.{fm.group(1)}")

print("## Existing Enums\n")
print("| Enum | Values | Used By |")
print("| ---- | ------ | ------- |")
for ename, body in enums.items():
    vals = [l.split("//")[0].strip() for l in body]
    vals = [v for v in vals if v]
    print(f"| `{ename}` | {', '.join(vals)} | {', '.join('`' + u + '`' for u in enum_used_by[ename])} |")

# --- models table -------------------------------------------------------
print("\n## Existing Models\n")
print("| Model | Relations | Indexes |")
print("| ----- | --------- | ------- |")
for mname, body in models.items():
    rels: list[str] = []
    idx: list[str] = []
    for line in body:
        s = line.strip()
        if not s or s.startswith("//"):
            continue
        if s.startswith("@@index"):
            idx.append(f"`{s}`")
            continue
        if s.startswith("@@unique"):
            idx.append(f"`{s}`")
            continue
        fm = re.match(r"(\w+)\s+(\w+)(\[\]|\?)?(\s+.*)?$", s)
        if not fm:
            continue
        fname, ftype = fm.group(1), fm.group(2)
        rest = fm.group(4) or ""
        if ftype in models:
            many = fm.group(3) == "[]"
            rel = ("has many " if many else "→ ") + ftype
            if rel not in rels:
                rels.append(rel)
        if "@unique" in rest:
            idx.append(f"`{fname} @unique`")
    rel_str = "; ".join(rels) if rels else "—"
    idx_str = ", ".join(idx) if idx else "—"
    print(f"| `{mname}` | {rel_str} | {idx_str} |")

print(f"\n<!-- {len(models)} models, {len(enums)} enums -->", file=sys.stderr)
