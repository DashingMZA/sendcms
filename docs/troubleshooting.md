# Troubleshooting

Fixes for the problems that come up most often, grouped by area. If a
symptom is not here, check the [operations runbook](operations/runbook.md)
for what to look at first, and the [REST API](rest-api.md) status table
for what a submit status code means.

## Contents

- [Sign-in and verification](#sign-in-and-verification)
- [Domain verification](#domain-verification)
- [Submissions](#submissions)
- [Email notifications](#email-notifications)
- [SDK](#sdk)

## Sign-in and verification

**"Email not verified" when signing in with email/password.**
You signed up but never clicked the verification link. Open the
verification email (check spam) and click the link, or sign in and use
**Resend verification email** on the account page. Links are valid for
24 hours — an expired link shows `TOKEN_EXPIRED`; request a new one.

**"Email not verified" after signing in with Facebook.**
By design: Facebook confirms the address exists but never confirms it
is verified, so every Facebook account starts unverified. Click the
verification email SendCMS sends on sign-up. Google and GitHub accounts
are trusted when the provider reports the address as verified.

**Password-reset link shows an error.**
The reset page reads the token from the URL (`/reset-password?token=…`).
If you copied the link by hand, copy the whole URL. Reset links are
valid for 1 hour and single-use — requesting a new reset invalidates
the previous one.

**No verification or reset email arrives.**
Check spam first. Then check the server: without an email provider
configured, non-production logs the link to the server console and
production fails loudly. Verify `RESEND_API_KEY` is set (or SMTP
credentials) and `RESEND_FROM` uses an address on a **verified** Resend
domain — sending from an unverified domain is rejected by Resend.

## Domain verification

**"TXT record does not contain the challenge yet."**
DNS propagation. TXT records can take minutes to an hour to be visible
worldwide. Confirm at your DNS provider that the record name is exactly
`sendcms._domainkey.<your domain>` and the value is exactly the
48-character code (no quotes, no extra spaces). Then click **Check
verification** again. Note that `example.com` itself returns a placeholder
DKIM record for any `*._domainkey` name — real domains do not.

**"Meta tag not found."**
The tag must be in the `<head>` of the domain's **home page** (the apex
or www root), served over HTTPS, with the exact attribute
`name="sendcms-verification"` and the code as `content`. A tag on a
subpage or behind a redirect to another host will not be found.

**"Verification file not found."**
The file must be served at `https://<domain>/sendcms-verification.txt`
(the domain root, not `/.well-known/`), contain only the code, and be
publicly reachable. Put it in the site's **public folder** — the same
place `ads.txt` goes. Use the **Download** button on the domain page so
the name and contents are exactly right.

**Verification expired / too many attempts.**
A verification is valid for 7 days and 10 attempts. After that, use
**Switch method** (or start a new verification) to get a fresh challenge.
The challenge stays the same when you only switch methods.

**"Only verified domains can be linked."**
The domain is still pending. Verify it first, then link it to the form.

## Submissions

| Symptom                                           | Cause / fix                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **403**                                           | The form's `Origin` must be a verified domain **linked to the form**. Check, in order: (1) the domain is verified, (2) it is linked on the form detail page, (3) the form is active, (4) the page actually sends an `Origin` header (a `file://` page or a missing header is rejected). Note that a 403 response carries no CORS headers, so the browser console shows a CORS error instead of the real message — check the network tab for the status code. |
| **422**                                           | A field failed validation. Common causes: a required field is empty, the email is not an email, a select value is not one of the configured options, or a field name in the form does not match the form's configuration (unknown keys are rejected). The response names the field.                                                                                                                                                                          |
| **429**                                           | Rate limit (10/min or 100/hour per IP) or the form's daily limit. Wait, or raise the daily limit on the form detail page.                                                                                                                                                                                                                                                                                                                                    |
| **503**                                           | Turnstile is enabled on the form but the server has no `TURNSTILE_SECRET_KEY`. Either set the key or turn Turnstile off.                                                                                                                                                                                                                                                                                                                                     |
| **Form submits but nothing appears in the inbox** | Check the Spam tab — the submission may have tripped the spam heuristics. Also check you are looking at the right form: the inbox filter may be set to another form or a date range.                                                                                                                                                                                                                                                                         |
| **Double submissions**                            | Send an `idempotencyKey` with each submit (the SDK generates one per submit). Without it, identical content within 10 minutes is deduped, but genuinely different content submitted twice is two submissions.                                                                                                                                                                                                                                                |

## Email notifications

**Test email fails with 502.**
The email provider rejected the send — the message names the reason.
The usual cause is `RESEND_FROM` using an address on an unverified
Resend domain. Verify the domain in Resend, then retry.

**Notifications arrive late or not at all.**
The submission is always saved first; delivery is separate. Check the
delivery log (`/dashboard/notifications`): a `PENDING` job with a future
`nextAttemptAt` is waiting for its retry slot. Retries run on the cron
route — if `CRON_SECRET` is unset or the cron is not scheduled, retries
never run. See [Deployment](deployment.md#email-outbox-cron) and
[Email notifications](email-notifications.md).

## SDK

**The form does nothing on submit.**
Open the browser console. The common causes: the script tag's
`src` is wrong (check `/forms/v1.js` loads), `data-user-id` /
`data-form-id` are wrong, or the form is missing `data-cms-form`.
The SDK also logs a warning when it cannot find any form to enhance.

**"Turnstile failed to load" and the form never submits.**
Turnstile is fail-closed by design: if its script cannot load, the
submission is not sent. Check the site key and network access to
`challenges.cloudflare.com`.
