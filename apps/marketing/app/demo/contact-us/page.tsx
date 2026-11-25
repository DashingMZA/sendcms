"use client"

import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import Script from "next/script"
import Link from "next/link"
import { apiUrl } from "@/lib/app-links"
import { cn } from "@sendcms/shared"
import { Button, Card } from "@sendcms/ui"

// Live demo of the "Contact us" form (admin@csofts.com's account).
// Two ways to submit the same form: the JavaScript SDK and the REST
// API. The SDK tab loads /forms/v1.js from the api app — the script
// auto-enhances the <form data-cms-form> below (and its
// MutationObserver re-enhances it when the tab mounts). The REST tab
// is a plain fetch POST to /api/public/v1/submit.
// The SDK exposes itself on window when /forms/v1.js loads. Declared
// locally — the marketing app does not depend on the SDK package.
declare global {
  interface Window {
    SendCMS?: { scan?: () => void }
  }
}

const FORM_USER_ID = "shSSZJGS9txSlU7DmPksq1qXuIxpJDcI"
const FORM_ID = "cmwlcr5xs0000gouynm83kjpm"

const REASON_OPTIONS = ["Support", "Sales", "Partnership", "Other"]

// The displayed snippets are built from the same api origin the page
// runs against (apiUrl()), so the code a visitor copies is the code
// this page is actually running — in dev that is the local api app, in
// production api.sendcms.bond (SDK-029). They were hardcoded production
// URLs while the live script/REST calls used the environment origin.
function buildSdkSnippet(api: string): string {
  return `<script src="${api}/forms/v1.js"
  data-user-id="${FORM_USER_ID}"
  data-form-id="${FORM_ID}"></script>

<form data-cms-form>
  <input name="name" required />
  <input name="email" type="email" required />
  <input name="company" />
  <select name="reason" required>
    <option>Support</option>
    <option>Sales</option>
    <option>Partnership</option>
    <option>Other</option>
  </select>
  <textarea name="message" required></textarea>
  <button type="submit">Send</button>
</form>`
}

function buildRestSnippet(api: string): string {
  return `const res = await fetch(
  "${api}/api/public/v1/submit",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: "${FORM_USER_ID}",
      formId: "${FORM_ID}",
      fields: { name, email, company, reason, message },
      idempotencyKey: crypto.randomUUID(),
      pageUrl: window.location.href,
    }),
  }
);
// 201 → { ok: true, id, message, redirectUrl }`
}

type Tab = "sdk" | "rest"

type RestState = {
  name: string
  email: string
  company: string
  reason: string
  message: string
}

const EMPTY_REST: RestState = {
  name: "",
  email: "",
  company: "",
  reason: "",
  message: "",
}

export default function ContactUsDemoPage() {
  const [tab, setTab] = useState<Tab>("sdk")
  const [rest, setRest] = useState<RestState>(EMPTY_REST)
  const [restSending, setRestSending] = useState(false)
  const [restResult, setRestResult] = useState<{
    ok: boolean
    text: string
  } | null>(null)
  const api = apiUrl()

  // The SDK watches the DOM for <form data-cms-form>, so it enhances
  // the SDK form when this tab mounts. Scan again on tab switch as a
  // belt-and-braces in case the script loaded before the form existed.
  useEffect(() => {
    if (tab === "sdk") {
      window.SendCMS?.scan?.()
    }
  }, [tab])

  async function submitRest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      !rest.name.trim() ||
      !rest.email.trim() ||
      !rest.reason ||
      !rest.message.trim()
    ) {
      setRestResult({
        ok: false,
        text: "Please fill in name, email, reason and message.",
      })
      return
    }
    setRestSending(true)
    setRestResult(null)
    try {
      // SRC-109: raw fetch stays here ON PURPOSE — this tab runs the
      // REST sample shown above (buildRestSnippet) verbatim, so the
      // code a visitor copies is the code that just ran. The real
      // contact form (app/contact) goes through apiFetch instead.
      const res = await fetch(`${api}/api/public/v1/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: FORM_USER_ID,
          formId: FORM_ID,
          fields: {
            name: rest.name,
            email: rest.email,
            company: rest.company,
            reason: rest.reason,
            message: rest.message,
          },
          idempotencyKey:
            typeof crypto !== "undefined" &&
            typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `sc-${Date.now().toString(36)}`,
          pageUrl: window.location.href,
          _sendcms_honeypot: "",
        }),
      })
      const body: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message =
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: unknown }).error)
            : "Submission failed."
        setRestResult({ ok: false, text: `Error (${res.status}): ${message}` })
      } else {
        const data = body as { id?: unknown; message?: unknown }
        setRestResult({
          ok: true,
          // End-user message only — the submission id stays in the API
          // response for the integrator, it is not shown to the visitor.
          text:
            typeof data.message === "string" && data.message
              ? data.message
              : "Thanks! We'll get back to you soon.",
        })
        setRest(EMPTY_REST)
      }
    } catch {
      setRestResult({
        ok: false,
        text: "Could not reach the server. Check your connection and try again.",
      })
    } finally {
      setRestSending(false)
    }
  }

  const inputCls =
    "block w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"

  return (
    <div className="mx-auto flex min-h-svh max-w-2xl flex-col px-4 py-12">
      {/* The SDK bundle, from the api app (not this marketing app). The
          form carries the same ids, so the SDK finds them either way. */}
      <Script
        src={`${api}/forms/v1.js`}
        data-user-id={FORM_USER_ID}
        data-form-id={FORM_ID}
        strategy="afterInteractive"
      />

      <header className="mb-6">
        <h1 className="mb-3 text-step-4 font-bold tracking-tight">
          Contact us — live demo
        </h1>
        <p className="leading-relaxed text-muted-foreground">
          This is the real{" "}
          <strong className="text-foreground">Contact us</strong> form from
          SendCMS. Try it two ways: the{" "}
          <strong className="text-foreground">JavaScript SDK</strong> (one
          script tag, the form just works) or the{" "}
          <strong className="text-foreground">REST API</strong> (a plain{" "}
          <code>fetch</code> call). Submissions land in the dashboard inbox.
        </p>
      </header>

      <div className="mb-6 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm leading-relaxed text-yellow-900 dark:border-yellow-900/50 dark:bg-yellow-950/40 dark:text-yellow-100">
        <strong>Note:</strong> a submission is only accepted when this
        page&apos;s domain is a <em>verified</em> domain linked to the form. If
        you see “This form does not accept submissions from this site”, link
        this domain to the form in the dashboard (Domains → verify → Forms →
        link it).
      </div>

      {/* Tabs */}
      <div
        className="flex gap-2"
        role="tablist"
        aria-label="Integration method"
      >
        {(
          [
            ["sdk", "JavaScript SDK"],
            ["rest", "REST API"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            onClick={() => setTab(id)}
            className={cn(
              "rounded-t-lg border border-b-0 px-4 py-2.5 text-sm font-semibold",
              tab === id
                ? "border-border bg-card text-primary"
                : "border-transparent bg-muted/60 text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ============ JavaScript SDK tab ============ */}
      {tab === "sdk" && (
        <Card
          id="panel-sdk"
          role="tabpanel"
          aria-labelledby="tab-sdk"
          className="rounded-tl-none p-6"
        >
          <h2 className="mb-1 text-step-1 font-semibold">JavaScript SDK</h2>
          <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
            Add the script tag and a <code>form[data-cms-form]</code> — the SDK
            enhances the form, handles the submit, and shows the status itself.
          </p>

          {/* Uncontrolled inputs: the SDK owns this form's DOM (it appends
              its own .sc-status element), so React does not manage the
              values. The ids are on the form too, so the SDK finds them
              even if the script tag's data attributes are ever lost. */}
          <form
            data-cms-form
            data-user-id={FORM_USER_ID}
            data-form-id={FORM_ID}
            className="flex flex-col gap-4"
          >
            <label className="text-sm font-medium">
              Name <span className="text-destructive">*</span>
              <input
                type="text"
                name="name"
                required
                autoComplete="name"
                className={cn(inputCls, "mt-1.5")}
              />
            </label>
            <label className="text-sm font-medium">
              Email <span className="text-destructive">*</span>
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                className={cn(inputCls, "mt-1.5")}
              />
            </label>
            <label className="text-sm font-medium">
              Company
              <input
                type="text"
                name="company"
                autoComplete="organization"
                className={cn(inputCls, "mt-1.5")}
              />
            </label>
            <label className="text-sm font-medium">
              Reason <span className="text-destructive">*</span>
              <select name="reason" required className={cn(inputCls, "mt-1.5")}>
                <option value="">Select a reason</option>
                {REASON_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium">
              Message <span className="text-destructive">*</span>
              <textarea
                name="message"
                required
                rows={4}
                className={cn(inputCls, "mt-1.5 resize-y")}
              />
            </label>
            <div>
              <Button type="submit">Send (SDK)</Button>
            </div>
          </form>

          <div className="mt-8">
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
              Embed code
            </h3>
            <pre className="overflow-x-auto rounded-lg bg-slate-950 p-4 font-mono text-[13px] leading-relaxed text-slate-200">
              <code>{buildSdkSnippet(api)}</code>
            </pre>
          </div>
        </Card>
      )}

      {/* ============ REST API tab ============ */}
      {tab === "rest" && (
        <Card
          id="panel-rest"
          role="tabpanel"
          aria-labelledby="tab-rest"
          className="rounded-tl-none p-6"
        >
          <h2 className="mb-1 text-step-1 font-semibold">REST API</h2>
          <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
            A plain <code>fetch</code> POST to{" "}
            <code>/api/public/v1/submit</code> — no SDK, no script tag. The
            response is shown below the button.
          </p>

          <form onSubmit={submitRest} className="flex flex-col gap-4">
            <label className="text-sm font-medium">
              Name <span className="text-destructive">*</span>
              <input
                type="text"
                name="name"
                required
                autoComplete="name"
                value={rest.name}
                onChange={(e) => setRest({ ...rest, name: e.target.value })}
                className={cn(inputCls, "mt-1.5")}
              />
            </label>
            <label className="text-sm font-medium">
              Email <span className="text-destructive">*</span>
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                value={rest.email}
                onChange={(e) => setRest({ ...rest, email: e.target.value })}
                className={cn(inputCls, "mt-1.5")}
              />
            </label>
            <label className="text-sm font-medium">
              Company
              <input
                type="text"
                name="company"
                autoComplete="organization"
                value={rest.company}
                onChange={(e) => setRest({ ...rest, company: e.target.value })}
                className={cn(inputCls, "mt-1.5")}
              />
            </label>
            <label className="text-sm font-medium">
              Reason <span className="text-destructive">*</span>
              <select
                name="reason"
                required
                value={rest.reason}
                onChange={(e) => setRest({ ...rest, reason: e.target.value })}
                className={cn(inputCls, "mt-1.5")}
              >
                <option value="">Select a reason</option>
                {REASON_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium">
              Message <span className="text-destructive">*</span>
              <textarea
                name="message"
                required
                rows={4}
                value={rest.message}
                onChange={(e) => setRest({ ...rest, message: e.target.value })}
                className={cn(inputCls, "mt-1.5 resize-y")}
              />
            </label>
            <div>
              <Button type="submit" disabled={restSending}>
                {restSending ? "Sending…" : "Send (REST API)"}
              </Button>
            </div>
          </form>

          {restResult && (
            <div
              role="status"
              className={cn(
                "mt-4 rounded-lg border px-4 py-3 text-sm leading-relaxed break-words whitespace-pre-wrap",
                restResult.ok
                  ? "border-green-200 bg-green-50 text-green-800 dark:border-green-900/50 dark:bg-green-950/40 dark:text-green-100"
                  : "border-red-200 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-100"
              )}
            >
              {restResult.text}
            </div>
          )}

          <div className="mt-8">
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
              Request
            </h3>
            <pre className="overflow-x-auto rounded-lg bg-slate-950 p-4 font-mono text-[13px] leading-relaxed text-slate-200">
              <code>{buildRestSnippet(api)}</code>
            </pre>
          </div>
        </Card>
      )}

      <p className="mt-8 text-center text-sm text-muted-foreground">
        <Link
          href="/"
          className="underline underline-offset-4 hover:text-foreground"
        >
          ← Back to SendCMS
        </Link>
      </p>
    </div>
  )
}
