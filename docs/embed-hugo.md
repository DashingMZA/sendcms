# Embedding SendCMS in Hugo

## Prerequisites

- A Hugo site
- A SendCMS account with a verified domain and a form (see
  [Getting started](getting-started.md))
- Your **userId** and the form's **formId** from the dashboard
  (form detail page → "Embed on your site")

## 1. Create a contact form partial

Create `layouts/partials/sendcms-form.html`:

```html
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

## 2. Include the partial in a page

In any layout or content file, for example `layouts/page/contact.html`:

```html
{{ define "main" }}
<article>
  <h1>{{ .Title }}</h1>
  {{ .Content }}
</article>

<section aria-label="Contact form">
  {{ partial "sendcms-form.html" . }}
</section>
{{ end }}
```

Or include it from a shortcode (`layouts/shortcodes/sendcms-form.html`
with the same markup, used as `{{< sendcms-form >}}` in Markdown).

## 3. Check it works

1. Submit the form on your site. You should see the success message
   (or your configured redirect).
2. Open **Inbox** in the SendCMS dashboard — the submission appears
   there with the page URL and origin domain.
3. If it returns 403, the page's origin is not a verified domain linked
   to the form — see [Troubleshooting](troubleshooting.md).

## Self-hosting note

If you self-host SendCMS, replace `https://YOUR_APP` with your
deployment URL in the `<script>` tag.
