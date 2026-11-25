"use client"

import { useState } from "react"
import type { FormEvent } from "react"
import { apiUrl } from "@/lib/app-links"
import { ApiClientError, apiFetch, cn } from "@sendcms/shared"
import { Button } from "@sendcms/ui"

// The real Contact us form (admin@csofts.com's account — the first /
// admin user). Submissions land in the dashboard inbox, exactly like
// the demo page at /demo/contact-us (same form, same ids). The demo
// page stays as it is; this is the plain contact form for visitors.
const FORM_USER_ID = "shSSZJGS9txSlU7DmPksq1qXuIxpJDcI"
const FORM_ID = "cmwlcr5xs0000gouynm83kjpm"

const REASON_OPTIONS = ["Support", "Sales", "Partnership", "Other"]

type FormState = {
  name: string
  email: string
  company: string
  reason: string
  message: string
}

const EMPTY_FORM: FormState = {
  name: "",
  email: "",
  company: "",
  reason: "",
  message: "",
}

export default function ContactForm() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{
    ok: boolean
    text: string
  } | null>(null)
  const api = apiUrl()

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      !form.name.trim() ||
      !form.email.trim() ||
      !form.reason ||
      !form.message.trim()
    ) {
      setResult({
        ok: false,
        text: "Please fill in name, email, reason and message.",
      })
      return
    }
    setSending(true)
    setResult(null)
    try {
      // SRC-109: the submit goes through apiFetch, not raw fetch —
      // typed errors + the same handling as every other client call.
      // (The demo page at /demo/contact-us keeps raw fetch on
      // purpose: it IS the displayed REST sample.)
      const data = await apiFetch<{ id?: unknown; message?: unknown }>(
        `${api}/api/public/v1/submit`,
        {
          method: "POST",
          body: JSON.stringify({
            userId: FORM_USER_ID,
            formId: FORM_ID,
            fields: {
              name: form.name,
              email: form.email,
              company: form.company,
              reason: form.reason,
              message: form.message,
            },
            idempotencyKey:
              typeof crypto !== "undefined" &&
              typeof crypto.randomUUID === "function"
                ? crypto.randomUUID()
                : `sc-${Date.now().toString(36)}`,
            pageUrl: window.location.href,
            _sendcms_honeypot: "",
          }),
        }
      )
      setResult({
        ok: true,
        // End-user message only — the submission id stays in the API
        // response for the integrator, it is not shown to the visitor.
        text:
          typeof data.message === "string" && data.message
            ? data.message
            : "Thanks! We'll get back to you soon.",
      })
      setForm(EMPTY_FORM)
    } catch (err) {
      // apiFetch throws ApiClientError with the server's message and
      // status; a network failure throws the fetch error itself.
      setResult({
        ok: false,
        text:
          err instanceof ApiClientError
            ? `Error (${err.status}): ${err.message}`
            : "Could not reach the server. Check your connection and try again.",
      })
    } finally {
      setSending(false)
    }
  }

  const inputCls =
    "block w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="text-sm font-medium">
        Name <span className="text-destructive">*</span>
        <input
          type="text"
          name="name"
          required
          autoComplete="name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
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
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          className={cn(inputCls, "mt-1.5")}
        />
      </label>
      <label className="text-sm font-medium">
        Company
        <input
          type="text"
          name="company"
          autoComplete="organization"
          value={form.company}
          onChange={(e) => setForm({ ...form, company: e.target.value })}
          className={cn(inputCls, "mt-1.5")}
        />
      </label>
      <label className="text-sm font-medium">
        Reason <span className="text-destructive">*</span>
        <select
          name="reason"
          required
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
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
          rows={5}
          value={form.message}
          onChange={(e) => setForm({ ...form, message: e.target.value })}
          className={cn(inputCls, "mt-1.5 resize-y")}
        />
      </label>
      <div>
        <Button type="submit" disabled={sending}>
          {sending ? "Sending…" : "Send message"}
        </Button>
      </div>

      {result && (
        <div
          role="status"
          className={cn(
            "rounded-lg border px-4 py-3 text-sm leading-relaxed break-words whitespace-pre-wrap",
            result.ok
              ? "border-green-200 bg-green-50 text-green-800 dark:border-green-900/50 dark:bg-green-950/40 dark:text-green-100"
              : "border-red-200 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-100"
          )}
        >
          {result.text}
        </div>
      )}
    </form>
  )
}
