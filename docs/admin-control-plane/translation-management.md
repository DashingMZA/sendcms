# Translation management (Admin Control Plane)

How translations are reviewed, validated, and added — and the
one rule that governs all of it: **the admin UI is read-only
for translations. No admin may overwrite a translation file
from the browser.** Translation changes go through the
version-controlled workflow: edit the JSON, run validation,
commit, push, deploy.

Related: [internationalization](./internationalization.md)
(the package and the honest locale state),
[platform-operations](./platform-operations.md) (the
translation-completion backend).

## Contents

- [The rule](#the-rule)
- [The read-only UI](#the-read-only-ui)
- [The validation workflow](#the-validation-workflow)
- [Adding a new domain](#adding-a-new-domain)
- [Adding a new locale](#adding-a-new-locale)
- [Fixing a missing or wrong key](#fixing-a-missing-or-wrong-key)
- [Export for external review](#export-for-external-review)
- [What is deliberately not built](#what-is-deliberately-not-built)

## The rule

Translation files live in the repo
(`packages/i18n/locales/{locale}/...`) and change only by
commit. There is **no write endpoint** for translations —
`getTranslationCompletion` and `exportTranslations` are the
only translation operations, both reads. An admin who wants a
wording change edits the JSON in the repo (or asks for the
change) — the admin app can show the gap, it cannot fix it.
This is a spec rule (additional requirements §4): the
translation management UI is read-only, "no browser overwrite
of translation files".

Why: a browser write would bypass review, bypass validation,
and diverge the running app from the repo in a way no deploy
could reproduce. The files are the source of truth; the
database never holds a translation.

## The read-only UI

Admin page: `/admin/translations` (capability
`MANAGE_TRANSLATIONS`). It shows the completion report from
`GET /api/v1/admin/translations` (`getTranslationCompletion`
in `@sendcms/platform-ops`):

- Per locale, per domain: `{ total, translated,
missingKeys[] }` — compared against `en`.
- An overall percent per locale (`en` itself is always 100%).
- A locale with no files for a domain has every key missing.

Every comparison goes through `@sendcms/i18n`'s loaders
(`loadLocaleDomain` / `loadLocaleAppDomain`) — never Node `fs`
reads from the service. A load failure for one domain never
fails the whole report. Proven by
`tests/platform-ops.test.ts` (translation completion detecting
missing keys).

## The validation workflow

```
edit packages/i18n/locales/{locale}/**/*.json
  → pnpm --filter @sendcms/i18n validate
  → fix every missing/orphan key
  → pnpm typecheck && pnpm test
  → commit (one commit per locale/domain change)
  → push (owner approval) → deploy
```

The validator (`packages/i18n/src/validate.ts`) is the gate:

1. Loads every domain for every locale through the app
   loaders.
2. Compares each locale's keys against `en` — missing keys
   and orphan keys both fail.
3. Reports coming-soon locales as "not started", not as
   failures.

It runs in CI, so a commit that drops a key cannot land
without the author seeing it. A missing key that does slip
through renders as `[missing: key]` in the UI (see
[internationalization](./internationalization.md)) — visible,
never silent.

## Adding a new domain

When a new admin page needs strings:

1. Create the domain file in **both** complete locales:
   `packages/i18n/locales/en/admin/<domain>.json` and
   `packages/i18n/locales/ur/admin/<domain>.json` (or the
   `dashboard/` subfolder for dashboard strings).
2. Write **real** translations in both — never English as a
   placeholder in `ur`. Keep keys flat, and keep provider /
   model / product names identical across locales (a translated
   provider name is a defect — it breaks matching).
3. Register the domain where the app loads it:
   `apps/admin/lib/i18n.ts` (`ADMIN_DOMAINS` /
   `SHELL_TRANSLATION_DOMAINS`) or the dashboard adapter
   (`DASHBOARD_DOMAINS`). A file that is not registered is not
   loaded, even if it exists.
4. Use it from the page: server components via
   `getTranslator(locale, "<domain>")`, client components via
   `useTranslation("<domain>")`.
5. Run `pnpm --filter @sendcms/i18n validate` — the new domain
   must be 100% in sync between `en` and `ur` before the
   commit lands.

Example counts from the phases: `admin/users.json` (178 keys),
`admin/ai.json` (100 keys), `admin/support.json` (62 keys),
`dashboard/support.json` (43 keys).

## Adding a new locale

To take a locale from `coming-soon` to `complete` (e.g. `ar`):

1. Translate **all 41 domains** — real translations, never
   machine-translated placeholders that break `{name}`
   interpolation or rename a provider/model. Every key in `en`
   must exist; no orphan keys.
2. Flip its status in `packages/i18n/src/locales.ts`
   (`SUPPORTED_LOCALES`) from `"coming-soon"` to
   `"complete"`. It then appears in `SELECTABLE_LOCALES` and
   the language picker offers it.
3. Run validation — the locale must be 100% in sync with `en`.
4. Check the direction: `ar` is `rtl`, so the layout, sidebar
   side, and logical classes must render correctly (the Urdu
   RTL work is the template — see
   [internationalization](./internationalization.md#rtl)).
   The other 7 coming-soon locales are all `ltr`.
5. Commit per locale, not all 8 at once — a 41-file translation
   is reviewed domain by domain.

Until step 2 lands, the locale is invisible to users:
`detectLocaleFromBrowserLanguage` never returns it, the
picker never offers it, and validation reports it as "not
started".

## Fixing a missing or wrong key

1. Find the key in the `en` file (the source locale) and fix
   it there first — `en` is the source; every other locale
   follows it.
2. Apply the same fix to `ur` (and any other complete locale).
   A key changed in `en` but not in `ur` fails validation.
3. Run the validator, then the app builds for the apps that
   render the domain (the admin build catches a bad JSON
   import; the validator catches a missing key).
4. Commit with the page or wording change it belongs to — not
   as a drive-by in an unrelated commit.

## Export for external review

`GET /api/v1/admin/translations/[locale]/export`
(`exportTranslations`, capability `MANAGE_TRANSLATIONS`)
returns one locale's domain JSONs as a single bundle, for
sending to a translator outside the repo. An unknown locale
is a 422. The bundle is a snapshot for review — importing it
back is a manual repo edit, not an upload endpoint. There is
no import endpoint by design.

## What is deliberately not built

- **No browser editing of translation files.** No write
  endpoint, no in-app editor. (Spec rule.)
- **No AI translation.** Machine translation of the files is
  permission-controlled, reviewable, and deferred — it is not
  built, and no translation in the repo is machine-generated.
- **No per-key review workflow in the UI.**
  `REVIEW_TRANSLATIONS` is a registered capability with no UI
  yet; review happens in the commit/PR flow today.
- **No retention or versioning inside the app.** The git
  history is the versioning for translations.
