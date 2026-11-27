---
description: "A dependency-free vanilla-TS snippet (10 KB minified) that turns any form into a SendCMS form — posts to the public API and blocks double submits."
---

# SendCMS JavaScript SDK

A dependency-free vanilla-TS snippet (10 KB minified) that turns any
`<form>` into a SendCMS form. It posts to the public submission API,
shows loading / success / error states, blocks double submits, adds a
honeypot bot trap, and supports Turnstile.

```mermaid
flowchart TB
    Page["Your page\n<script src=\".../forms/v1.js\">"]
    Enhance["SDK auto-enhances\n<form data-cms-form>"]
    Submit["Visitor submits\n→ collect fields + idempotency key\n+ page URL (+ Turnstile token)"]
    API["POST /api/public/v1/submit"]
    State["Button disabled, 'Sending…'\n→ success / error status\n→ reset or redirect"]

    Page --> Enhance --> Submit --> API --> State
```

Source: `packages/sdk/` (esbuild → `apps/api/public/forms/v1.js`).
Architecture detail: [Architecture — SDK architecture](architecture.md#sdk-architecture).
Direct endpoint reference: [REST API](rest-api.md).

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Multiple forms and overrides](#multiple-forms-and-overrides)
- [SPA navigation and Astro](#spa-navigation-and-astro)
- [Programmatic API](#programmatic-api)
- [Turnstile](#turnstile)
- [Styling](#styling)
- [Direct REST API](#direct-rest-api)
- [No-JS fallback (plain HTML POST)](#no-js-fallback-plain-html-post)

## Quick start

1. In the dashboard, open a form → **Embed on your site** and copy the
   snippet. It looks like this:

```html
<script
  src="https://YOUR_APP/forms/v1.js"
  data-user-id="USER_ID"
  data-form-id="FORM_ID"
></script>

<form data-cms-form>
  <label
    >Name
    <input type="text" name="name" required />
  </label>
  <label
    >Email
    <input type="email" name="email" required />
  </label>
  <label
    >Message
    <textarea name="message" required></textarea>
  </label>
  <button type="submit">Send</button>
</form>
```

2. Paste it where the form should appear. The SDK auto-enhances every
   `<form data-cms-form>` on the page — no JavaScript of your own is
   needed.

The form's field names must match the field keys configured in the
dashboard. Extra fields are rejected by the API (422).

## How it works

- On submit, the SDK collects the form's fields, adds a fresh
  idempotency key and the current page URL, and POSTs JSON to
  `/api/public/v1/submit`.
- The submit button is disabled while sending, with a "Sending…"
  label; a status message appears under the button (success text comes
  from the form's success message when set).
- On success the form resets (unless a redirect is configured) and
  `onSuccess` fires. On failure the server's error message is shown
  and `onError` fires.
- A second submit while one is in flight is ignored.
- A hidden honeypot input (`_sendcms_honeypot`) is added to every
  form; bots that fill it get a fake success and nothing is saved.
- File inputs are not supported (the API takes text only): the SDK
  warns once per form in the console and the file is never sent.
  Disabled inputs are excluded, like `FormData` itself excludes them.
- If a form has no `userId`/`formId` anywhere (script tag, `init()`,
  or its own data attributes), the SDK logs a console warning naming
  the missing id and leaves the form alone — the form then submits
  natively, so check the console when a form reloads the page and
  nothing arrives.
- `window.SendCMS.version` reports the bundle version (taken from the
  SDK package version at build time). It is diagnostic only — nothing
  gates on it.
- Submissions are only accepted from domains that are **verified and
  linked to the form** (the API enforces this by the page's Origin).
  Link domains in the dashboard first, or every submit returns 403.

Config resolution (highest priority first): form data attributes >
`init()` options > script tag data attributes. The API origin resolves
from the script `src` origin first, then the build-time `__APP_URL__`.
`init()` ignores `undefined`-valued keys, so a later `init()` can
never wipe values set by an earlier one, and `enhance()` on an
already-enhanced form refreshes its config instead of ignoring the
new options. When the bundle is hosted somewhere other than the API
app (a CDN, or imported from npm), the origin cannot be inferred:
pass `apiUrl` to `init()` — without a resolvable API URL the SDK
warns in the console and `submit()` throws instead of posting to the
host site.

## Multiple forms and overrides

Several forms can live on one page — even from different accounts.
Each form can override the script tag's defaults with its own
attributes:

```html
<script src="https://YOUR_APP/forms/v1.js"></script>

<form data-cms-form data-user-id="USER_A" data-form-id="FORM_A">…</form>
<form data-cms-form data-user-id="USER_B" data-form-id="FORM_B">…</form>
```

## SPA navigation and Astro

Forms added after page load (client-side routing, Astro view
transitions) are picked up automatically via a `MutationObserver` and
the `astro:page-load` event. Forms that gain `data-cms-form` — or
change `data-user-id` / `data-form-id` / `data-turnstile-site-key` —
after load are picked up the same way. For fully manual control:

```js
SendCMS.enhance(document.querySelector("#my-form"))
```

Loading the bundle twice keeps the first instance (its handlers own
the forms), and `SendCMS.destroy()` disconnects the observer and
releases `window.SendCMS` so a later load starts clean.

## Programmatic API

```js
// Global defaults (callbacks, messages, redirect). May be called any
// time — it also refreshes forms that are already enhanced.
SendCMS.init({
  userId: "USER_ID",
  formId: "FORM_ID",
  messages: {
    sending: "Sending…",
    success: "Thanks! We'll be in touch.",
    error: "Something went wrong. Please try again.",
  },
  redirectUrl: "https://example.com/thanks",
  resetOnSuccess: true, // default true
  honeypot: true, // default true
  onSuccess: (result, form) => {
    /* result.id, result.message */
  },
  onError: (error, form) => {
    /* error.status, error.message */
  },
  onSubmit: (form) => {},
})

// Submit without touching the DOM (custom UI).
const result = await SendCMS.submit(formElement, {
  name: "Ali",
  email: "ali@example.com",
  message: "Hello",
})
```

| Option                               | Default                                      | Notes                                                                                                                |
| ------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `userId` / `formId`                  | script tag's `data-user-id` / `data-form-id` | A form's own `data-*` attributes win                                                                                 |
| `apiUrl`                             | origin of the `<script>` tag                 | Override only when the bundle is hosted elsewhere (CDN / npm import — otherwise the SDK warns and `submit()` throws) |
| `turnstileSiteKey`                   | —                                            | Set when the form has Turnstile on (see below)                                                                       |
| `redirectUrl`                        | —                                            | The form's own redirectUrl wins when set                                                                             |
| `resetOnSuccess`                     | `true`                                       | Skipped when redirecting                                                                                             |
| `honeypot`                           | `true`                                       | Adds the hidden trap input                                                                                           |
| `messages`                           | see code                                     | `sending`, `verifying`, `success`, `error`                                                                           |
| `onSuccess` / `onError` / `onSubmit` | —                                            | Errors in callbacks never break the flow                                                                             |

## Turnstile

If a form has Turnstile enabled, pass its site key and the SDK
fetches a token on submit (invisible widget, fail closed):

```html
<script
  src="https://YOUR_APP/forms/v1.js"
  data-user-id="USER_ID"
  data-form-id="FORM_ID"
  data-turnstile-site-key="0x4AAAAAAA…"
></script>
```

Or per form: `<form data-cms-form data-turnstile-site-key="…">`, or
via `SendCMS.init({ turnstileSiteKey: "…" })`. Without a site key the
SDK never loads the Turnstile script. The secret key
(`TURNSTILE_SECRET_KEY`) stays server-side — see `.env.example`.

The token is fetched before the submission, with a 15 s timeout for
both the Turnstile script load and the token wait (aligned with the
15 s submit timeout); the status line shows "Verifying…" while
waiting. Both fail closed: no token, no submission. The widget is
torn down through the Turnstile API after every attempt.

## Styling

The SDK styles only its own status message (classes `sc-status`,
`sc-status--sending`, `sc-status--success`, `sc-status--error`). Your
form's inputs keep your site's own styles — the SDK never touches
them.

## Direct REST API

```http
POST https://YOUR_APP/api/public/v1/submit
Content-Type: application/json

{
  "userId": "USER_ID",
  "formId": "FORM_ID",
  "fields": { "name": "Ali", "email": "ali@example.com", "message": "Hello" },
  "idempotencyKey": "optional-client-key",
  "pageUrl": "https://example.com/contact",
  "turnstileToken": "only when the form has Turnstile on"
}
```

| Status | Meaning                                                                                       |
| ------ | --------------------------------------------------------------------------------------------- |
| 201    | Saved. Body: `{ ok, id, message, redirectUrl }`                                               |
| 200    | Duplicate — same idempotency key, or same content within 10 minutes. Same body, original `id` |
| 403    | Origin not allowed (domain not verified/linked), form paused, or Turnstile failed             |
| 413    | Payload over 64 KB                                                                            |
| 422    | Validation failed (unknown field, bad email, missing required, …)                             |
| 429    | Daily form limit, or per-IP 10/min / 100/hour                                                 |
| 503    | Turnstile is enabled but the server has no secret configured                                  |

The honeypot field (`_sendcms_honeypot`) returns 201 with a fake id
and saves nothing. CORS headers are only echoed for allowed origins.
Full reference: [REST API](rest-api.md).

## No-JS fallback (plain HTML POST)

A native form works without JavaScript at all — post form-encoded
data straight to the same endpoint:

```html
<form action="https://YOUR_APP/api/public/v1/submit" method="POST">
  <input type="hidden" name="userId" value="USER_ID" />
  <input type="hidden" name="formId" value="FORM_ID" />
  <input name="name" required />
  <input name="email" type="email" required />
  <textarea name="message" required></textarea>
  <button type="submit">Send</button>
</form>
```

On success the browser is redirected (303) to the form's
`redirectUrl`, or back to the referring page with
`?cms_submitted=1`. On failure it goes back with
`?cms_error=<message>`. Checkbox groups (same name twice) arrive as
arrays; file inputs are ignored.
