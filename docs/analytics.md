---
description: "Reading the Analytics page: submission totals over time, per-form counts, and how the numbers relate to the inbox."
---

# Analytics

**Analytics** in the dashboard (`/dashboard/analytics`) shows how
your forms are doing: how many submissions arrive, and when. It is a
read-only view over the submissions already in your inbox — nothing
here changes data.

## What you see

- **Totals over time** — submissions per day across your forms, for
  the selected range. A flat stretch means no submissions arrived,
  not missing data.
- **Per-form counts** — how many submissions each form received in
  the range, so you can compare forms at a glance.
- **Status split** — how many submissions are NEW, READ, STARRED,
  ARCHIVED, or SPAM. Spam is counted separately: a form with heavy
  spam shows a large SPAM count but its inbox stays clean.

## What the numbers mean

- The totals count **saved** submissions. A submission rejected at
  the door (unverified origin, paused form, filled honeypot) is
  never saved and never appears here.
- The daily form limit and your monthly submission quota (see
  [Billing](billing.md)) cap how many submissions can arrive; if a
  form's curve flattens at the same height every day, check whether
  the form hit its daily limit.
- Digests and AI re-scoring (see [AI & BYOK](ai-byok.md)) do not
  change these counts — re-scoring can only move a submission into
  SPAM, which moves it between the status buckets without changing
  the total.

## From numbers to submissions

Analytics answers "how many, when". For the submissions themselves,
open the [inbox](getting-started.md) — search, filters, and bulk
actions live there, not here.
