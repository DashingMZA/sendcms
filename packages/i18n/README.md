# `@sendcms/i18n`

Domain-based translations for the SendCMS admin app. English is the source
locale. Framework-free (only `Intl` + JSON) so it is safe to import from
server components, client components, and services alike.

## Structure

```
packages/i18n/
  src/
    locales.ts    # Locale registry (10 locales, dir, status) + detection
    translate.ts  # createTranslator + {name} interpolation + plurals
    format.ts     # Intl date/time/number/currency/percent/relative helpers
    load.ts       # Registry + dynamic domain loading + path helpers
    index.ts      # Barrel
  locales/
    en/           # Source locale (complete)
      {domain}.json          # Shared domains
      admin/{domain}.json    # Admin-app domains
      dashboard/{domain}.json # Customer-dashboard domains (later)
    ur/           # Urdu, RTL (complete)
    es/ ar/ fr/ de/ hi/ bn/ id/ it/  # Coming soon
  scripts/
    validate-translations.mjs
```

- **Never one large file per locale.** Every domain is its own JSON file
  with flat key-value string pairs (the VARKA model).
- Shared domains live at the locale root (`common`, `actions`, `errors`,
  `validation`, …). App-specific domains live under an app subfolder
  (`admin/navigation.json`, `admin/dashboard.json`).
- Placeholders are `{name}`. Keep them identical across locales. Technical
  identifiers, provider names (`SendCMS`, `API`, `MCP`, `AI`, `URL`) and
  code snippets stay unchanged in every locale.

## Using it in the admin app

```ts
import commonEn from "@sendcms/i18n/locales/en/common.json"
import { registerTranslations, getTranslator } from "@sendcms/i18n"

// Register once (e.g. in the app shell); reads are then synchronous.
registerTranslations("en", "common", commonEn)
const t = getTranslator("en", "common")
t("save") // "Save"
t("welcome", { name: "Zaheer" }) // "Welcome back, Zaheer"
```

For a domain that is not needed on first paint, lazy-load it instead:

```ts
import { loadLocaleDomain } from "@sendcms/i18n"
const messages = await loadLocaleDomain("ur", "common")
```

## Adding a locale

1. Add the entry to `SUPPORTED_LOCALES` in `src/locales.ts`
   (`code`, `name`, `nativeName`, `dir`, `status: "coming-soon"`).
2. Create `locales/{code}/` and copy the `en` file list into it.
3. Translate every key (never copy English as a placeholder).
4. Run `pnpm --filter @sendcms/i18n validate` and flip the status to
   `"complete"` when it passes.

## Adding a domain

1. Create `locales/en/{domain}.json` (or `locales/en/{app}/{domain}.json`).
2. Mirror the file under `locales/ur/` with real Urdu translations.
3. Add the domain name to `SHARED_DOMAINS` / `ADMIN_DOMAINS` in `src/load.ts`.
4. Run the validation script.

## Validation

```bash
pnpm --filter @sendcms/i18n validate
```

Checks that every JSON file parses and that `en` and `ur` have identical
key sets per domain. The 8 coming-soon locales are reported as
"not started" without failing. Exits non-zero only when `en`/`ur` are
incomplete or a JSON file is invalid.

## RTL rules

- `ur` and `ar` are RTL. Set `dir="rtl"` on the app root from
  `getLocaleDirection(code)` — never hardcode it per page.
- Use logical CSS properties (`margin-inline-start`, `padding-inline-end`,
  `inset-inline-start`, `text-align: start`) instead of hardcoded
  `left`/`right`. Tailwind's `ms-*`/`me-*`/`ps-*`/`pe-*`/`start-*`/`end-*`
  utilities are logical already — prefer them.
- Do not mirror every icon. Directional icons (back/forward chevrons,
  pagination arrows) flip in RTL; brand, status, and action icons do not.
- Dates, times, numbers, currency, and percentages go through `src/format.ts`
  so they follow the active locale.
- The language selector shows only locales with status `"complete"`
  (`SELECTABLE_LOCALES`); coming-soon locales are listed disabled with a
  "soon" label, never as broken options.
