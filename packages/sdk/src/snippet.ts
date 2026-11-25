// Pure snippet builders for the API & SDK page (Phase 9) and the
// per-form embed snippet on the form detail page. These are pure
// string builders — no DOM, no imports — so the dashboard and the
// tests can use them directly.

export function buildSdkScriptTag(appUrl: string, userId: string): string {
  return `<script src="${appUrl}/forms/v1.js" data-user-id="${userId}"></script>`
}

/** The shape buildEmbedSnippet needs from a form — structural, so
    callers pass their own form detail type without importing it. */
export type EmbedSnippetField = {
  name: string
  label: string
  type: string
  required: boolean
  placeholder?: string | null
  options?: unknown
}

export type EmbedSnippetForm = {
  id: string
  ownerId: string
  turnstileEnabled: boolean
  fields: EmbedSnippetField[]
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}

/** Builds the copy-paste embed snippet for a form: the SDK script tag
    plus a <form> with this form's fields. The SDK auto-enhances the
    form — no JavaScript of your own is needed. When the form has
    Turnstile enabled and a site key is given, the script tag carries
    `data-turnstile-site-key` so the SDK fetches a token on submit;
    without a key the attribute is omitted (the dashboard shows a
    warning instead of a working-looking snippet). */
export function buildEmbedSnippet(
  appUrl: string,
  form: EmbedSnippetForm,
  turnstileSiteKey?: string | null
): string {
  const turnstileAttr =
    form.turnstileEnabled && turnstileSiteKey
      ? ` data-turnstile-site-key="${escapeAttr(turnstileSiteKey)}"`
      : ""
  const lines: string[] = [
    `<script src="${appUrl}/forms/v1.js" data-user-id="${form.ownerId}" data-form-id="${form.id}"${turnstileAttr}></script>`,
    `<form data-cms-form>`,
  ]
  for (const field of form.fields) {
    const required = field.required ? " required" : ""
    const placeholder = field.placeholder
      ? ` placeholder="${escapeAttr(field.placeholder)}"`
      : ""
    const options = Array.isArray(field.options)
      ? (field.options as unknown[]).filter(
          (o): o is string => typeof o === "string"
        )
      : []
    const label = escapeAttr(field.label)
    switch (field.type) {
      case "TEXTAREA":
        lines.push(
          `  <label>${label}`,
          `    <textarea name="${field.name}"${placeholder}${required}></textarea>`,
          `  </label>`
        )
        break
      case "SELECT":
        lines.push(
          `  <label>${label}`,
          `    <select name="${field.name}"${required}>`,
          ...options.map(
            (o) =>
              `      <option value="${escapeAttr(o)}">${escapeAttr(o)}</option>`
          ),
          `    </select>`,
          `  </label>`
        )
        break
      case "CHECKBOX":
      case "RADIO": {
        const inputType = field.type === "CHECKBOX" ? "checkbox" : "radio"
        lines.push(`  <fieldset>`, `    <legend>${label}</legend>`)
        for (const o of options) {
          lines.push(
            `    <label><input type="${inputType}" name="${field.name}" value="${escapeAttr(o)}"${required}> ${escapeAttr(o)}</label>`
          )
        }
        lines.push(`  </fieldset>`)
        break
      }
      default: {
        const inputType =
          field.type === "EMAIL"
            ? "email"
            : field.type === "NUMBER"
              ? "number"
              : field.type === "URL"
                ? "url"
                : field.type === "TEL"
                  ? "tel"
                  : field.type === "DATE"
                    ? "date"
                    : "text"
        lines.push(
          `  <label>${label}`,
          `    <input type="${inputType}" name="${field.name}"${placeholder}${required}>`,
          `  </label>`
        )
      }
    }
  }
  lines.push(`  <button type="submit">Send</button>`, `</form>`)
  return lines.join("\n")
}

export function buildFormExample(appUrl: string, userId: string): string {
  return `<form data-cms-form data-form-id="YOUR_FORM_ID">
  <input name="name" placeholder="Your name" required />
  <input name="email" type="email" placeholder="you@example.com" required />
  <textarea name="message" placeholder="Your message" required></textarea>
  <button type="submit">Send</button>
</form>

<!-- ${appUrl} is where your forms live; YOUR_FORM_ID is the id shown
     on a form's detail page. data-user-id is your public user id: -->
${buildSdkScriptTag(appUrl, userId)}`
}

export function buildRestExample(appUrl: string, userId: string): string {
  return `curl -X POST ${appUrl}/api/public/v1/submit \\
  -H "Content-Type: application/json" \\
  -H "Origin: https://your-site.example" \\
  -d '{
    "userId": "${userId}",
    "formId": "YOUR_FORM_ID",
    "fields": { "name": "Ali", "email": "ali@example.com", "message": "Hello" }
  }'`
}
