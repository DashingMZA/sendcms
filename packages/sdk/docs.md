# SDK Contributor Guide

## Overview

Vanilla TypeScript embed that enhances `<form data-cms-form>` on any
page. Bundles to `public/forms/v1.js` via esbuild. No framework, no
runtime dependencies — all DOM work is imperative. (The honeypot field
name comes from `@sendcms/shared/constants` at build time and is
inlined into the bundle; nothing is fetched from the server.) It
replaced the old comment widget (`widget/`) for contact forms; that
widget was removed with the comment system on 2026-11-18.

## Source layout

```
packages/sdk/src/
  index.ts      — SendCMS global, auto-init, SPA observer, resolveConfig
  enhance.ts    — enhanceForm: honeypot, submit handler, states, redirects
  api.ts        — fetch wrapper for POST /api/public/v1/submit
  turnstile.ts  — optional Cloudflare Turnstile (invisible widget)
  styles.ts     — scoped .sc-* CSS, injected once
  types.ts      — public option/result types
  snippet.ts    — embed-snippet builders for the dashboard API page
```

## Build

```bash
pnpm sdk:build   # minified → public/forms/v1.js + debug → public/forms/v1.debug.js
```

Runs automatically as part of `pnpm dev` and `pnpm build`. The build
reads `.env` then `.env.local` for `NEXT_PUBLIC_APP_URL`, inlined as
the compile-time `__APP_URL__` constant. The bundle prefers the
`<script>` tag's own origin at runtime and only falls back to
`__APP_URL__` when it cannot be determined.

## Compile-time constants

| Constant | Source |
|---|---|
| `__APP_URL__` | `NEXT_PUBLIC_APP_URL` env var |

**Never** read `process.env` in `packages/sdk/src`.

## Rendering model

`enhanceForm` is idempotent (guarded by `data-sc-enhanced`) and stores
the form's live config in a `WeakMap`. The submit handler reads the
live config at submit time, so `SendCMS.init()` calls made after page
load (e.g. registering callbacks) still apply to already-enhanced
forms.

States live on the form itself: the submit button is disabled with
`aria-busy` while sending, and a `.sc-status` element (created on
first submit) shows sending / success / error text. Styles are scoped
to `.sc-*` classes — the host's inputs are never styled.

## Testing

`tests/sdk.test.ts` loads the real built bundle into jsdom. One jsdom
quirk: a `<script>` element appended to the document executes, but its
JS globals land in the jsdom window's own vm context, not on the test
file's `window` — so the bundle is loaded with `window.eval(bundle)`
(then `window.fetch` mocks and `window.SendCMS` are shared). Only the
script-tag test uses `appendChild` and asserts DOM effects only.
Rebuild the bundle (`pnpm sdk:build`) before running the tests, or
the tests exercise a stale bundle.
