# SendCMS JavaScript SDK

A dependency-free vanilla-TS snippet (7 KB minified) that turns any
`<form>` into a SendCMS form. It posts to the public submission API,
shows loading / success / error states, blocks double submits, adds a
honeypot bot trap, and supports Turnstile.

## Quick start

1. In the dashboard, open a form → **Embed on your site** and copy the
   snippet. It looks like this:

```html
<script src="https://YOUR_APP/forms/v1.js"
  data-user-id="USER_ID" data-form-id="FORM_ID"></script>

<form data-cms-form>
  <label>Name
    <input type="text" name="name" required>
  </label>
  <label>Email
    <input type="email" name="email" required>
  </label>
  <label>Message
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
- Submissions are only accepted from domains that are **verified and
  linked to the form** (the API enforces this by the page's Origin).
  Link domains in the dashboard first, or every submit returns 403.

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
the `astro:page-load` event. For fully manual control:

```js
SendCMS.enhance(document.querySelector("#my-form"))
```

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
  onSuccess: (result, form) => { /* result.id, result.message */ },
  onError: (error, form) => { /* error.status, error.message */ },
  onSubmit: (form) => {},
})

// Submit without touching the DOM (custom UI).
const result = await SendCMS.submit(formElement, {
  name: "Ali",
  email: "ali@example.com",
  message: "Hello",
})
```

| Option | Default | Notes |
|---|---|---|
| `userId` / `formId` | script tag's `data-user-id` / `data-form-id` | A form's own `data-*` attributes win |
| `apiUrl` | origin of the `<script>` tag | Override only when the bundle is hosted elsewhere |
| `turnstileSiteKey` | — | Set when the form has Turnstile on (see below) |
| `redirectUrl` | — | The form's own redirectUrl wins when set |
| `resetOnSuccess` | `true` | Skipped when redirecting |
| `honeypot` | `true` | Adds the hidden trap input |
| `messages` | see code | `sending`, `success`, `error` |
| `onSuccess` / `onError` / `onSubmit` | — | Errors in callbacks never break the flow |

## Turnstile

If a form has Turnstile enabled, pass its site key and the SDK
fetches a token on submit (invisible widget, fail closed):

```html
<script src="https://YOUR_APP/forms/v1.js"
  data-user-id="USER_ID" data-form-id="FORM_ID"
  data-turnstile-site-key="0x4AAAAAAA…"></script>
```

Or per form: `<form data-cms-form data-turnstile-site-key="…">`, or
via `SendCMS.init({ turnstileSiteKey: "…" })`. Without a site key the
SDK never loads the Turnstile script. The secret key
(`TURNSTILE_SECRET_KEY`) stays server-side — see `.env.example`.

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

| Status | Meaning |
|---|---|
| 201 | Saved. Body: `{ ok, id, message, redirectUrl }` |
| 200 | Duplicate — same idempotency key, or same content within 10 minutes. Same body, original `id` |
| 403 | Origin not allowed (domain not verified/linked), form paused, or Turnstile failed |
| 413 | Payload over 64 KB |
| 422 | Validation failed (unknown field, bad email, missing required, …) |
| 429 | Daily form limit, or per-IP 10/min / 100/hour |
| 503 | Turnstile is enabled but the server has no secret configured |

The honeypot field (`_sendcms_honeypot`) returns 201 with a fake id
and saves nothing. CORS headers are only echoed for allowed origins.

## No-JS fallback (plain HTML POST)

A native form works without JavaScript at all — post form-encoded
data straight to the same endpoint:

```html
<form action="https://YOUR_APP/api/public/v1/submit" method="POST">
  <input type="hidden" name="userId" value="USER_ID">
  <input type="hidden" name="formId" value="FORM_ID">
  <input name="name" required>
  <input name="email" type="email" required>
  <textarea name="message" required></textarea>
  <button type="submit">Send</button>
</form>
```

On success the browser is redirected (303) to the form's
`redirectUrl`, or back to the referring page with
`?cms_submitted=1`. On failure it goes back with
`?cms_error=<message>`. Checkbox groups (same name twice) arrive as
arrays; file inputs are ignored.
