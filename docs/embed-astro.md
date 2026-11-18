# Embedding SendCMS in Astro

## Prerequisites

- An Astro site
- A SendCMS account with a verified domain and a form (see
  [Getting started](getting-started.md))
- Your **userId** and the form's **formId** from the dashboard
  (form detail page → "Embed on your site")

## 1. Add the form to a page

Put the SDK script tag and a normal HTML form in any `.astro` file.
Put `data-user-id` and `data-form-id` on the **form** itself — that is
the most reliable place for them, and it works with Astro's page
transitions too.

```astro
---
// src/pages/contact.astro
---

<script src="https://YOUR_APP/forms/v1.js"></script>

<form data-cms-form data-user-id="YOUR_USER_ID" data-form-id="YOUR_FORM_ID">
  <label>
    Name
    <input name="name" required />
  </label>
  <label>
    Email
    <input name="email" type="email" required />
  </label>
  <label>
    Message
    <textarea name="message" required></textarea>
  </label>
  <button type="submit">Send</button>
</form>
```

Replace `YOUR_APP`, `YOUR_USER_ID`, and `YOUR_FORM_ID` with your values.
The form's fields must match the fields configured on the form in the
dashboard — extra field names are rejected by the API.

## 2. Page transitions

The SDK listens for `astro:page-load` and re-scans the page after every
transition, and a `MutationObserver` picks up forms added later. No
extra code is needed for Astro's view transitions — just keep the
script tag on the page (or in your layout) and the form in the page.

If you put the script tag in a shared layout and the form in a page,
that works too: the SDK enhances forms whenever they appear.

## 3. Check it works

1. Submit the form on your site. You should see the success message
   (or your configured redirect).
2. Open **Inbox** in the SendCMS dashboard — the submission appears
   there with the page URL and origin domain.
3. If it returns 403, the page's origin is not a verified domain linked
   to the form — see [Troubleshooting](troubleshooting.md).
