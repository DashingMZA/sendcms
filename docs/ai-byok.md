---
description: "AI in SendCMS: per-form opt-in, the platform key vs your own key (BYOK), browser-only vs server storage, and what the four AI capabilities do."
---

# AI & BYOK

SendCMS has four AI capabilities, all per-form opt-in: spam
re-scoring, the inbox digest, form-builder suggestions, and reply
drafts. They all live under **AI** in the dashboard
(`/dashboard/ai`), plus a per-form toggle on the form itself. No AI
capability runs on a form until you opt that form in — and no model
call happens at all until a key is configured.

## The four capabilities

- **Spam re-scoring** — a model re-scores NEW submissions on
  AI-enabled forms (score 0–100 + a reason). It can only ADD a SPAM
  flag, never remove one the heuristics set. Re-scoring runs in the
  background (cron + email worker) with a daily cap per form
  (`AI_DAILY_CALL_CAP`, default 100 calls).
- **Inbox digest** — a 2–3 sentence summary plus up to 5 highlights
  of NEW submissions since the last digest, emailed to the form
  owner. Daily by default (`AI_DIGEST_INTERVAL_HOURS`, default 24);
  the window advances only when a digest is actually sent, and empty
  forms are skipped.
- **Form-builder suggestions** — describe a form in plain language
  and the model suggests fields, which you review and add selected
  (in the form's Fields tab, AI panel).
- **Reply drafts** — the model drafts a subject + body for one
  submission (inbox detail, Reply section). You review and edit
  before sending; sending goes through the email outbox, and the
  model is never re-run at send time.

If AI is off for a form (or no key exists), everything degrades to
the non-AI behaviour: heuristic spam filtering, no digest, no draft.
Nothing on the submit path ever fails because AI is unavailable.

## Platform key vs your own key (BYOK)

Each provider has two possible keys:

- The **platform key** — set by the platform admin in the
  environment. It is the default for everyone.
- **Your own key (BYOK)** — one per provider, saved from the AI page.
  Your own key **pauses** the platform key for that provider until
  you re-enable the platform key. A provider can also be
  **disabled** entirely by the admin, which wins over both keys: a
  disabled provider is unusable even with your own key saved.

The five providers are OpenAI, Anthropic, Google (Gemini), DeepSeek,
and OpenRouter. The model is chosen per provider (a default per
provider, overridable).

## Where your key is stored

When you save a key, you choose:

- **Browser only** — the key stays in your browser (local storage).
  The server never sees it; model calls for that key run from your
  browser session. Background jobs (re-scoring, digests) cannot use
  a browser-only key.
- **Both (browser + server)** — the key is also stored encrypted on
  the server, so background jobs can use it. Server-stored keys are
  encrypted with a master key held in the platform environment —
  never hashed, never stored in plain text.

## Testing a key

Every saved key has a **Test** button. It makes one real model call
with that key and reports success or the provider's error, so you
know the key works before relying on it. A key that fails its test
still saves — fix or replace it, then test again.

## Per-form opt-in

AI is off by default per form. Turn it on in the form's settings
(the AI toggle). The toggle only gates that form's submissions:
re-scoring only covers NEW, unscored submissions on AI-enabled
forms, and digests only cover AI-enabled forms.
