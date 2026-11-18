// Pure snippet builders for the API & SDK page (Phase 9). The
// per-form embed snippet lives in the form detail page; these are
// the account-level ones: your public user id, the SDK script tag
// and the direct REST call.

export function buildSdkScriptTag(appUrl: string, userId: string): string {
  return `<script src="${appUrl}/forms/v1.js" data-user-id="${userId}"></script>`
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
