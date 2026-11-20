# ADR 0010 — AI platform design (design only, not built)

- Status: proposed (2026-11-19, Phase 12) — design only, **not implemented**
- Build status (2026-11-20): Step 1 (per-form opt-in) and Step 1b
  (provider plumbing) are BUILT on branch `feature/ai`. Step 1:
  `Form.aiEnabled` + dashboard toggle. Step 1b: `packages/ai`
  (`@sendcms/ai`) — Vercel AI SDK `ai` 7.0.178 (exact pin) with five
  providers the owner named (OpenAI, Anthropic, Google Gemini,
  DeepSeek, OpenRouter), selected by `AI_PROVIDER` or auto-detected
  from the key present, model via `AI_MODEL` or a per-provider
  default. **Step 2 (spam re-scoring) is BUILT (same branch):**
  `packages/ai` `rescoreSpam` (model scores 0–100 + a reason,
  threshold `AI_SPAM_THRESHOLD` default 70), `packages/modules/submissions`
  `rescoreNewSubmissions` (NEW + unscored + `aiEnabled` forms only;
  daily cap `AI_DAILY_CALL_CAP` default 100 per form, DB-backed in
  `AiDailyUsage`; the model can only ADD a SPAM flag, never unflag),
  wired into the email worker's poll loop and the cron route (so
  serverless deployments re-score too). **Step 3 (inbox digest) is
  BUILT (same branch):** `packages/ai` `generateDigest` (model writes
  a 2–3 sentence summary + up to 5 highlights, interval
  `AI_DIGEST_INTERVAL_HOURS` default 24 = daily), `sendDueDigests`
  in `@sendcms/submissions` (AI-enabled forms only; covers NEW
  submissions since `Form.lastDigestAt`; skips empty forms; window
  advances only when a digest is sent), emailed to the form owner via
  the outbox (new `EmailJobType.DIGEST` + `EmailJob.payload` holding
  the pre-rendered content; a digest template in `@sendcms/email`),
  wired into the worker poll loop and the cron route. **No model call
  has happened yet — no provider key exists, so Steps 2–3 are
  live-verified no-ops until a key is set.** **Step 4 (form-builder +
  reply drafts) is BUILT (same branch):** `packages/ai`
  `suggestFields` (model suggests fields from a plain-language
  description, validated against the FormFieldType enum) +
  `draftReply` (model drafts a subject + body for one submission),
  served by three session-gated api routes
  (`POST /api/v1/forms/[formId]/ai/suggest-fields`,
  `POST /api/v1/inbox/[submissionId]/ai/draft-reply`,
  `POST /api/v1/inbox/[submissionId]/ai/send-reply`), with dashboard
  UI in the form Fields tab (AI panel: describe → review → add
  selected) and the inbox detail (Reply section: draft → review/edit
  → send). Replies go through the outbox as a new
  `EmailJobType.SUBMISSION_REPLY` job (owner's words on the payload;
  the model is never re-run at send time). **Phase 12 is complete —
  all four capabilities built; no model call has happened yet (no
  provider key exists).**
- Context: the audit's Phase 12 ("AI foundation") and the owner's
  2026-11-18 decision to defer MCP/AI entirely. The owner asked for the
  design document now (2026-11-19) and will decide separately when — or
  whether — to build it. This record is the Phase 12 deliverable. **No
  code was written for it: no `packages/ai`, no provider, no keys, no
  endpoints, no worker changes, no schema change.**

## What AI would be for SendCMS

Four capabilities, in build order (highest value, lowest risk first).
All four are owner-facing features over the data SendCMS already holds —
none of them changes what a submission is or how it is stored.

| #   | Capability                | What it does                                                                                       | Where it plugs in                                                 |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | Spam classification       | A model re-scores submissions the heuristics already handled, catching the spam the two rules miss | `@sendcms/submissions` (`detectSpam`) + the email worker          |
| 2   | Inbox digest              | A daily/weekly summary of NEW submissions per form, emailed to the owner                           | `@sendcms/inbox` + `@sendcms/notifications` + the email worker    |
| 3   | AI-assisted form building | Suggest fields from a plain-language description; the owner reviews before any field is created    | `@sendcms/forms` (dashboard-initiated)                            |
| 4   | Auto-reply drafts         | Draft a reply to a submission; the owner reviews and edits before anything is sent                 | `@sendcms/inbox` + `@sendcms/notifications` (dashboard-initiated) |

The current spam story, for contrast: `detectSpam` in
`packages/modules/submissions/src/service.ts` has exactly two rules —
more than 3 links ("too many links") and a 4+ character word repeated
10+ times ("repeated content"). A submission with any reason is stored
as SPAM, otherwise NEW. That is the whole spam system today, and it
stays the default whatever AI is added later.

## Decision 1 — The submit path never blocks on a model call

`submitForm` is the hot path: a visitor's form post must succeed
quickly and must never fail because a provider is down, slow, or
unpaid. So:

- Spam re-scoring is **async, after the save**. The submission is
  stored immediately with the heuristic verdict (SPAM or NEW). The
  worker later re-scores NEW submissions and may upgrade one to SPAM.
  AI **never auto-unflags** a submission the heuristics (or a human)
  already marked SPAM — it can only flag, or surface a score for the
  owner to review.
- Form building and reply drafts are **dashboard-initiated**, not
  submit-path. The owner clicks, the model runs, the owner reviews.
- If the provider is down, times out, or has no key, the feature
  degrades to the non-AI behavior (heuristics for spam, no digest, no
  draft) — never a 500 on the submit path, never a blocked dashboard.

## Decision 2 — Integration shape: Vercel AI SDK, provider at build time

The integration layer is the Vercel AI SDK (`ai` **7.0.177**, latest
stable, verified live via `npm view` 2026-11-19). It is **not** added
to any `package.json` in this docs-only phase — pin it at build time,
when the then-latest stable is checked again.

No provider is picked now, and no provider key exists. The provider
(model + key + billing) is chosen at build time, against the privacy
rules in Decision 4. Model calls happen **server-side only** — never
in the browser, never in the public SDK bundle (that bundle is served
to every visitor; a key there would leak).

The AI package follows the same layered flow as everything else (repo
`AGENTS.md`): its capability functions call the module services, never
`@sendcms/database` directly, and never `next/*`.

## Decision 3 — Hosting: `packages/ai` + the existing email worker

- `packages/ai` (`@sendcms/ai`, private, when built): the provider
  client + one capability module per row of the table above (spam,
  digest, form-builder, drafts).
- Async work runs in the existing `services/email-worker` (it already
  polls every 30s and has a health endpoint + graceful shutdown, ADR
  0007). **No new `services/ai-worker`** until a real workload exists
  that the email worker can't host (audit §9: workers only where a
  real workload exists). A second worker for the same poll loop would
  be a placeholder.
- No new app. The dashboard initiates form-building and drafts; the
  api app serves nothing AI-shaped until a capability needs an endpoint
  (spam re-scoring and the digest need none — the worker does them).

## Decision 4 — Privacy: per-form opt-in, default off (the honest boundary)

Submissions contain PII (name, email, message text). Sending them to a
third-party model provider is the one decision in this document that
cannot be undone by deleting code, so it has the strictest rules:

- **Per-form opt-in, default off.** A form-level setting (a future
  schema change, not made now); the owner enables AI per form, never
  globally by default. A capability function checks the form's setting
  first and does nothing when it is off — no model call, no data sent.
- **No submission content in logs.** The structured logger (ADR 0008)
  must never receive PII, and the audit log must never record
  submission content — same rule as the audit writer already follows.
- **Provider terms before any wiring.** Data-processing terms and a
  no-training commitment are required before a provider key is set.
  The provider is picked against those terms, not just on price.
- **No separate PII store.** Model outputs that contain PII (a
  summary, a draft) live with the form's data, not in a second store.

## Decision 5 — Cost + failure behavior

Model calls cost per token, so the design includes a budget before the
first call is made: a per-form / per-owner daily AI-call cap, enforced
in the DB the same way the public submit's rate limits are (DB-backed,
ADR 0005-era pattern) — otherwise one form's spam wave becomes a
billing event. The cap, the provider, and the per-call cost are
dashboard-visible when the feature ships, so the owner sees what AI
cost before it costs.

Failure behavior follows Decision 1: provider errors degrade to the
non-AI behavior. A missing key is a configuration state, not an
exception in the submit path.

## Decision 6 — What is explicitly not in this phase

No code, no package, no provider, no keys, no endpoints, no worker
changes, no schema change (the per-form opt-in setting is a future
migration, not made now), no test. The design above is the
deliverable. Nothing here is callable, and no submission is sent to
any model today.

## Build order (when the owner says build)

1. **Per-form AI opt-in setting** (schema + dashboard UI) + provider
   key plumbing. Nothing else ships before this — it is the privacy
   gate for everything below.
2. **Spam re-scoring** (async, worker-hosted) — highest value, lowest
   risk: it only ever adds SPAM flags, and the heuristics stay the
   default.
3. **Inbox digest** (worker-hosted, emailed via the outbox).
4. **Form-builder + reply drafts** (dashboard-initiated, owner reviews
   before anything is created or sent).

Each step is gated by the same checks as any other phase: the existing
journey (the submit path must behave identically with AI off), the
gates, and a live verification that no submission content reaches a
provider for a form that hasn't opted in.

## Verification (2026-11-19)

- The current spam story was verified by reading `detectSpam`
  (`packages/modules/submissions/src/service.ts`, lines 235–271) and
  the status assignment in `submitForm` (line 411): two rules, SPAM
  vs NEW, nothing else.
- The SDK version (`ai` 7.0.177) was verified live via `npm view`
  2026-11-19. No provider was evaluated — the provider choice is
  deliberately left to build time, when its terms can be checked
  against Decision 4.
- No code changed in this phase, so the gates are a no-op confirmation:
  typecheck / lint / tests are re-run before the commit to confirm
  nothing moved (they must match the Phase 10/11 numbers: typecheck
  25/25, lint 0 errors / 1 pre-existing warning, tests 227/227).
