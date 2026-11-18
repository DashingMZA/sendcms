# Security

## How submissions are protected

| Threat | Mitigation |
| ------ | ---------- |
| Someone else submitting to your form | `Origin` allowlist: only **verified domains linked to the form** are accepted. Anything else gets 403 with no CORS headers. |
| Cross-site request forgery | The public API takes no cookies and no session — the `Origin` check is the CSRF protection. |
| Bot spam | Honeypot trap field (on by default), spam heuristics (link count, repeated content), optional Cloudflare Turnstile (fail-closed: a failed check rejects the submission, and a missing server secret answers 503 instead of letting bots through). |
| Duplicate / replayed submits | Idempotency keys plus a 10-minute content-hash dedupe window. |
| Flooding | 10 submissions/min and 100/hour per IP, plus a per-form daily limit. Payloads over 64 KB are rejected. |
| Malicious field content | Field values are validated against the form's config (types, lengths, allowed options) and stored as JSON; the dashboard renders them as text, never as HTML. |
| Fake submissions from your own site's visitors | None of the above verifies the *person* — SendCMS verifies the *origin*. If your site itself is compromised, submissions from it will look legitimate. |
| Credential theft | No API keys exist to steal. The only secrets are server-side: `BETTER_AUTH_SECRET`, `RESEND_API_KEY` (or SMTP credentials), `CRON_SECRET`, and the Turnstile secret. |

## How accounts are protected

- Email/password sign-in requires a verified email. Unverified sign-ins
  are refused with `EMAIL_NOT_VERIFIED`.
- OAuth email trust varies: Google trusts `email_verified`, GitHub trusts
  its `verified` flag, Facebook trusts nothing — Facebook users get a
  verification email.
- Passwords are hashed by Better Auth (scrypt). Password resets use
  single-use tokens valid for 1 hour; verification links are valid for
  24 hours.
- The first account created on an instance becomes the platform owner
  (enforced by a conditional update plus a partial unique index, so a
  race cannot create two owners).
- Changing your account email sends the verification code to the **new**
  address; the change applies only after it is verified.
- Every sensitive dashboard action writes an audit log row (create /
  update / delete / verify / suspend / reactivate) with the acting user,
  resource, and IP.

## What is logged, and what is not

- Submissions store the origin domain, page URL, IP address, and user
  agent — the minimum needed for moderation and abuse investigation.
- Passwords and secrets are never logged. The verification challenge is a
  random token, not a hash of anything.
- Email delivery attempts (provider, message id, error) are logged per
  job in the delivery log (`/dashboard/notifications`).

## Reporting a vulnerability

If you find a security issue in SendCMS, report it to the repository
owner privately (open a private security advisory on GitHub) instead of
opening a public issue.
