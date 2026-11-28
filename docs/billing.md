---
description: "Plans, checkout, subscriptions, usage limits, payment history, and cancellation — everything on the Billing page in the dashboard."
---

# Billing

Your plan, your usage, and your payments live on **Billing** in the
dashboard (`/dashboard/billing`). This page covers what you can do
there and how checkout works.

## Your current plan

The Billing page shows your current subscription: the plan, its price
and billing interval, and the renewal date. Plans are versioned — the
price and limits you see are the plan's current published version,
the same data the marketing pricing page reads
(`GET /api/public/v1/plans`). Only plans the admin has published (and
not marked private) can be taken; a plan the admin later changes does
not change your existing subscription's terms.

## Taking or changing a plan

Pick a plan on the pricing page or on Billing. Checkout opens at
`/dashboard/billing/checkout`:

- Your country is detected from the request; if it cannot be
  detected, you pick it on the page. Only the payment providers the
  admin enabled **for your country** appear — for example, a US
  customer sees PayPal and Stripe, a Pakistan customer sees Gumroad
  and Stripe. A provider with no configured credentials never
  appears.
- Checkout is one of Stripe, PayPal, Polar, or Freemius (whatever the
  admin enabled). Gumroad is registered-only: it cannot sell through
  SendCMS checkout, so a Gumroad purchase is activated manually by
  an admin afterwards.
- The free plan needs no payment: take it from the same page.
- After a provider checkout you land back on Billing with
  `?checkout=success` (or a pending state while the provider's
  webhook confirms the payment — the webhook is what activates the
  subscription, so a slow webhook means a short wait, not a lost
  payment).

## One-time purchases

Some plans are one-time, not subscriptions: you pay once and get
access until a finite access date. A one-time purchase is a separate
record from a subscription — it does not renew, and it does not
become lifetime access.

## Usage limits

The usage section shows your plan's limits against your actual use
(forms, domains, submissions this month, API keys, AI calls per day).
`null` in a plan's entitlements means unlimited for that meter. When
a limit is hit, the action that needs it is refused with a clear
error — upgrade the plan (or, for AI, add your own key — see
[AI & BYOK](ai-byok.md)) to go further.

## Payment history

Every charge, refund, and renewal appears in payment history, with
the provider, the amount actually paid, and the date. Where a coupon
discounted the price, the full plan price is shown struck through
next to what was actually paid.

## Refunds

Refunds are handled by the platform admin, not from this page. The
policy: a **full** refund cancels the subscription (you drop to the
Free plan); a **partial** refund keeps the subscription as-is. Either
way the refund shows in your payment history.

## Cancelling

Cancel from Billing (the cancel action on your subscription). The
subscription stays active until the end of the current billing
period, then ends — it is not cut off immediately. Cancelling a
subscription does not delete your forms or submissions.
