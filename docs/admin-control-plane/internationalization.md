# Internationalization (Admin Control Plane)

The admin (and dashboard) UI is translated through
`packages/i18n` — domain-based JSON files, flat keys, real
translations, RTL where the language needs it. This doc states
the honest state first, because it is the part most often
misread: **English and Urdu are complete; the other 8 locales
are coming-soon.**

## Contents

- [The honest state](#the-honest-state)
- [The 10 locales](#the-10-locales)
- [File layout](#file-layout)
- [The translator](#the-translator)
- [Missing keys](#missing-keys)
- [Validation](#validation)
- [Locale detection, switching, and persistence](#locale-detection-switching-and-persistence)
- [RTL](#rtl)
- [How the apps use it](#how-the-apps-use-it)
- [What is not done](#what-is-not-done)

## The honest state

Owner decision, 2026-11-21: **English + Urdu first** (covers
LTR + RTL); the other 8 locales later. The spec asked for 10
complete locales — that is **not** what shipped, and this doc
does not present it as done. The registry is built for 10 so
the other 8 land without restructuring, but today:

| Fact                             | Value                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------- |
| Complete locales                 | `en`, `ur`                                                                        |
| Domain files per complete locale | 41                                                                                |
| Keys                             | 100% in sync between `en` and `ur` (`pnpm --filter @sendcms/i18n validate`)       |
| Coming-soon locales              | `es`, `ar`, `fr`, `de`, `hi`, `bn`, `id`, `it` — 0 files each                     |
| Arabic RTL                       | **Not built** — `ar` has no files, so no RTL rendering of Arabic exists to verify |
| Urdu RTL                         | Built — sidebar on the right, `dir="rtl"` (see [RTL](#rtl))                       |

The acceptance matrix records proofs 10, 12, and 13 as
**NOT MET** for exactly this reason — see
[acceptance-matrix](./acceptance-matrix.md).

## The 10 locales

Registry: `packages/i18n/src/locales.ts`
(`SUPPORTED_LOCALES`). `status` is `complete` or
`coming-soon`; `SELECTABLE_LOCALES` is the complete-only
filter the language picker actually offers.

| Code | Language   | Direction | Status      |
| ---- | ---------- | :-------: | ----------- |
| `en` | English    |    LTR    | complete    |
| `ur` | Urdu       |    RTL    | complete    |
| `es` | Spanish    |    LTR    | coming-soon |
| `ar` | Arabic     |    RTL    | coming-soon |
| `fr` | French     |    LTR    | coming-soon |
| `de` | German     |    LTR    | coming-soon |
| `hi` | Hindi      |    LTR    | coming-soon |
| `bn` | Bengali    |    LTR    | coming-soon |
| `id` | Indonesian |    LTR    | coming-soon |
| `it` | Italian    |    LTR    | coming-soon |

`DEFAULT_LOCALE` is `en`. `detectLocaleFromBrowserLanguage`
maps a `navigator.language` tag to a renderable locale: Urdu
if the primary subtag is `ur`, English otherwise — never to a
translation key or an incomplete locale.

## File layout

```
packages/i18n/
  src/
    locales.ts        # registry (above)
    load.ts           # domain loaders (loadLocaleDomain / loadLocaleAppDomain)
    translate.ts      # createTranslator, interpolation, plurals
    validate.ts       # validation script (pnpm --filter @sendcms/i18n validate)
    index.ts          # barrel
  locales/
    en/               # 41 files
      navigation.json
      admin/
        users.json billing.json support.json plans.json ...
      dashboard/
        billing.json support.json ai.json ...
    ur/               # 41 files, same shape, real Urdu script
    es/ ar/ fr/ ...   # do not exist yet
```

Domain-based JSON files, flat keys — the structure the owner
showed in the VARKA `en.zip` reference (separate domain files,
flat key-value JSON). One domain per file: `admin/users.json`
(178 keys), `admin/support.json` (62 keys),
`dashboard/support.json` (43 keys), `admin/ai.json` (100 keys),
and so on. `admin/` and `dashboard/` subfolders sit inside each
locale directory. Keys are flat (`"title"`, `"welcome"`) — no
nesting. Values are real translations, never English as a
placeholder: the Urdu files are real Urdu script.

New domains land with the page that needs them — each admin
page ships with its domain files in `en` + `ur` in the same
commit as the page.

## The translator

`createTranslator(locale, domain)` (in
`packages/i18n/src/translate.ts`) returns a `t(key, vars?)`
function:

- **Interpolation:** `{name}` placeholders, e.g.
  `t("welcome", { name })`.
- **Plurals:** `Intl.PluralRules` — the translator picks the
  plural form for the locale, so a domain file can carry
  `one` / `other` forms without the component branching.
- **Formatting:** `Intl` formatting through the package's
  helpers (dates, numbers) so the locale's conventions apply.
- **Missing keys render `[missing: key]`** — visible in dev,
  never silent, never an English fallback that would hide the
  gap. See [Missing keys](#missing-keys).

Server components get their translator from the app's i18n
adapter (`apps/admin/lib/i18n.ts` — `getTranslator(locale,
domain)`); client components use the `useTranslation(domain)`
hook. The locale comes from the request (cookie → detection),
never from a hardcoded default in a component.

## Missing keys

A missing key renders as `[missing: key]` in the UI
(`packages/i18n/src/translate.ts:24`) — and as
`[missing: plural]` for a missing plural form. That is
deliberate: a missing translation must be visible, not papered
over with English. The validation script is the gate that
catches them before they reach a user (below); the render-time
placeholder is the backstop for keys added without their
translations.

## Validation

Command: `pnpm --filter @sendcms/i18n validate`
(`packages/i18n/src/validate.ts`). It loads every domain for
every locale through the same loaders the apps use
(`loadLocaleDomain` / `loadLocaleAppDomain`) and compares
against `en`:

- Every key in `en` must exist in every other complete locale.
- Every key in a locale must exist in `en` (no orphan keys).
- A locale with no files for a domain has every key missing —
  reported, not crashed.
- A load failure for one domain never fails the whole report.

Current output (2026-11-22):

```
fr: not started (0/41 files)
de: not started (0/41 files)
hi: not started (0/41 files)
bn: not started (0/41 files)
id: not started (0/41 files)
it: not started (0/41 files)

✓ en and ur are complete and in sync.
```

The script runs in CI. A missing key in a complete locale
fails the check. Coming-soon locales are reported as "not
started", not failed — the check knows the difference between
"not built yet" and "broken".

## Locale detection, switching, and persistence

The owner's spec (2026-11-21), implemented in Phase 2:

1. **Detect** from the browser/system:
   `navigator.language`, mapped by
   `detectLocaleFromBrowserLanguage` to `en` or `ur`.
2. **Ask, don't force.** A popup asks whether to stay in
   English or switch to the detected language. No detection →
   English.
3. **Persist twice.** The choice is stored in the browser (the
   `sendcms-locale` cookie, 1-year) **and** in the database
   (`User.locale`, migration
   `20261121201308_add_user_locale`). The next visit shows the
   stored language until the user changes it. One honest
   limit: the database copy is the durable record, not the
   live source — nothing in the admin layout reads
   `User.locale` on load, so today the cookie decides the
   language and the stored preference does not yet follow the
   user across devices.
4. **The write path:** `setUserLocale` / `getUserLocale` in
   `@sendcms/users`, exposed as
   `POST /api/v1/users/me/locale` on the api app. The cookie
   write is best-effort and never blocks the UI.

The admin app reads the locale per request
(`getRequestLocale` in `apps/admin/lib/i18n.ts`) and renders
the page in it. The language selector sits in the admin
sidebar; the language prompt is a client component shown once
per browser until the user picks.

## RTL

Two RTL locales are registered: `ur` (complete) and `ar`
(coming-soon). Only `ur` RTL exists in a renderable form.

- **`dir` on `<html>`.** The admin root layout
  (`apps/admin/app/layout.tsx`) sets `lang` and `dir` from the
  locale via `getLocaleDirection(locale)` — `dir="rtl"` for
  Urdu, `dir="ltr"` for English.
- **Sidebar side.** The shadcn `Sidebar` pins itself with
  physical positioning (default `side="left"`), so `dir="rtl"`
  alone does not move it. The admin shell passes `side` from
  the locale direction
  (`apps/admin/components/admin/app-sidebar.tsx:217` —
  `<Sidebar collapsible="icon" side={side}>`): **right in RTL,
  left in LTR**. This was a real user-reported bug (Phase 6
  code rendered the sidebar on the left in Urdu) and the fix
  was verified in code; the user's visual check is still owed.
- **Logical CSS.** Components use logical properties and
  classes (`ps` / `pe` / `ms` / `me` / `start`) instead of
  physical `left` / `right`, so padding, margins, and alignment
  flip with the direction.
- **Dashboard RTL is a follow-up.** The dashboard shell is
  still `lang="en"` with no `dir` handling; the
  `/dashboard/ai` page content is translated, but full
  dashboard RTL is not built.

## How the apps use it

| App                                   | Locale handling                                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/admin`                          | Full: `getRequestLocale` per request, `dir` on `<html>`, sidebar side from direction, language selector + prompt, domain JSONs under `admin/`                                |
| `apps/dashboard`                      | Partial: `/dashboard/ai` content translated via the dashboard adapter (`DASHBOARD_BILLING_DOMAINS`, `DASHBOARD_SUPPORT_DOMAINS`); shell still `lang="en"`, no `dir` handling |
| `apps/marketing` / `docs` / `updates` | Not translated — public pages are English-only; no i18n wiring                                                                                                               |

The admin shell translation domains are registered in
`apps/admin/lib/i18n.ts` (`SHELL_TRANSLATION_DOMAINS`); the
dashboard adapter registers its own. A domain missing from
the registration is not loaded, even if the file exists.

## What is not done

- **The other 8 locales.** `es`, `ar`, `fr`, `de`, `hi`, `bn`,
  `id`, `it` have no files. Adding one means translating the
  41 domains (real translations, never machine-translated
  placeholders that break interpolation or change a
  provider/model name) and flipping its registry status to
  `complete`. See
  [translation-management](./translation-management.md).
- **Arabic RTL.** Registered as RTL but with no files, so there
  is nothing to render or verify.
- **Full dashboard RTL.** Shell `lang`/`dir` handling is owed.
- **No AI translation.** Translation is human-authored and
  version-controlled; machine translation of the files is not
  built.
