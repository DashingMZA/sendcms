---
description: "How SendCMS protects submissions, accounts, and data — spam checks, Origin verification, rate limits — and what it deliberately does not verify."
---

# Security

How SendCMS protects submissions, accounts, and data — and what it
deliberately does not verify. The system-level view (apps, layered
flow, data model) is in [Architecture](architecture.md); day-to-day
operations are in the [runbook](operations/runbook.md).

## Contents

- [How submissions are protected](#how-submissions-are-protected)
- [How accounts are protected](#how-accounts-are-protected)
- [What is logged, and what is not](#what-is-logged-and-what-is-not)
- [Platform security (admin control plane)](#platform-security-admin-control-plane)
- [Reporting a vulnerability](#reporting-a-vulnerability)

## How submissions are protected

| Threat                                         | Mitigation                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Someone else submitting to your form           | `Origin` allowlist: only **verified domains linked to the form** are accepted. Anything else gets 403 with no CORS headers.                                                                                                                       |
| Cross-site request forgery                     | The public API takes no cookies and no session — the `Origin` check is the CSRF protection.                                                                                                                                                       |
| Bot spam                                       | Honeypot trap field (on by default), spam heuristics (link count, repeated content), optional Cloudflare Turnstile (fail-closed: a failed check rejects the submission, and a missing server secret answers 503 instead of letting bots through). |
| Duplicate / replayed submits                   | Idempotency keys plus a 10-minute content-hash dedupe window.                                                                                                                                                                                     |
| Flooding                                       | 10 submissions/min and 100/hour per IP, plus a per-form daily limit. Payloads over 64 KB are rejected.                                                                                                                                            |
| Malicious field content                        | Field values are validated against the form's config (types, lengths, allowed options) and stored as JSON; the dashboard renders them as text, never as HTML.                                                                                     |
| Fake submissions from your own site's visitors | None of the above verifies the _person_ — SendCMS verifies the _origin_. If your site itself is compromised, submissions from it will look legitimate.                                                                                            |
| Credential theft                               | No API keys exist to steal. The only secrets are server-side: `BETTER_AUTH_SECRET`, `RESEND_API_KEY` (or SMTP credentials), `CRON_SECRET`, and the Turnstile secret.                                                                              |

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

## Platform security (admin control plane)

✅ On the `feature/admin-control-plane` branch (Phase 9, **not
deployed**), the platform adds:

| Control                                                                                                            | Where                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Nonce-based CSP, enforcing on all five page apps                                                                   | [admin-control-plane/csp.md](admin-control-plane/csp.md)                             |
| Admin-API rate limiting (600/min + 10,000/hour per user) and auth sign-in limits (20/min per IP, 10/min per email) | [admin-control-plane/rate-limiting.md](admin-control-plane/rate-limiting.md)         |
| Step-up re-auth (10-minute window) for irreversible actions                                                        | [admin-control-plane/authorization.md](admin-control-plane/authorization.md)         |
| Capability model (26 capabilities) and role matrix                                                                 | [admin-control-plane/authorization.md](admin-control-plane/authorization.md)         |
| Append-only audit trail with `reason` / `correlationId` / `outcome`                                                | [admin-control-plane/admin-audit-trail.md](admin-control-plane/admin-audit-trail.md) |

Until that branch merges and deploys, the production posture is the one
in the sections above: no CSP, and no rate limiting on the admin REST
API or the auth routes (deferred gap, ADR 0008).

## Reporting a vulnerability

If you find a security issue in SendCMS, report it to the repository
owner privately (open a private security advisory on GitHub) instead of
opening a public issue.
