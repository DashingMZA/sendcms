// Wave 9 Stream A (TST-015) — worker-condition render probe.
//
// Renders each real email template the way the standalone worker
// does: under tsx, launched from services/email-worker (whose
// tsconfig covers only its own src/, so the automatic JSX runtime
// does NOT apply to the templates in packages/email/src). Run via:
//   pnpm --filter @sendcms/email-worker exec tsx ../../tests/tsx-render-probe.ts
// (or the repo-root tsx binary with cwd services/email-worker).
// Exit 0 only when every template renders to non-empty HTML.
// This file is NOT a vitest test (vitest runs under Vite, which
// applies the automatic runtime and would mask the defect).
import { render } from "@react-email/render"
import { notificationDeps } from "../packages/email/src/notification-deps"
import { VerifyEmail } from "../packages/email/src/templates/verify-email"
import { ResetPasswordEmail } from "../packages/email/src/templates/reset-password"

const receivedAt = new Date("2026-11-25T12:00:00Z")

async function main(): Promise<void> {
  const results: Array<{ name: string; chars: number }> = []

  const notification = await notificationDeps.renderNotification({
    formName: "Contact us",
    senderName: "Sara",
    senderEmail: "sara@example.com",
    fields: [{ label: "message", value: "Hello" }],
    pageUrl: "https://example.com/contact",
    originDomain: "example.com",
    receivedAt,
    inboxUrl: "http://localhost:3002/dashboard/inbox/sub-1",
    accentColor: "#0891b2",
    footerText: "Notification footer.",
    locale: "en",
  })
  results.push({
    name: "submission-notification",
    chars: notification.html.length,
  })

  const digest = await notificationDeps.renderDigest({
    formName: "Contact us",
    count: 1,
    summary: "One new submission.",
    highlights: [],
    items: [
      {
        senderName: "Sara",
        snippet: "Hello",
        receivedAt,
      },
    ],
    inboxUrl: "http://localhost:3002/dashboard/inbox?formId=form-1",
    accentColor: "#0891b2",
    footerText: "Digest footer.",
    locale: "en",
  })
  results.push({ name: "digest", chars: digest.html.length })

  const reply = await notificationDeps.renderReply({
    formName: "Contact us",
    body: "Hi Sara, thanks for writing.",
    accentColor: "#0891b2",
    footerText: "Reply footer.",
    locale: "en",
  })
  results.push({ name: "reply", chars: reply.html.length })

  const verify = await render(
    VerifyEmail({
      userName: "Sara",
      url: "https://example.com/verify?token=x",
      accentColor: "#0891b2",
      footerText: "Verify footer.",
      locale: "en",
    })
  )
  results.push({ name: "verify-email", chars: verify.length })

  const reset = await render(
    ResetPasswordEmail({
      userName: "Sara",
      url: "https://example.com/reset?token=x",
      accentColor: "#0891b2",
      footerText: "Reset footer.",
      locale: "en",
    })
  )
  results.push({ name: "reset-password", chars: reset.length })

  for (const r of results) {
    console.log(`rendered ${r.name}: ${r.chars} chars`)
    if (r.chars < 100)
      throw new Error(`${r.name} rendered suspiciously short HTML`)
  }
  console.log("tsx-render-probe: all templates rendered")
}

main().catch((err) => {
  console.error(
    `tsx-render-probe FAILED: ${err instanceof Error ? err.message : String(err)}`
  )
  process.exit(1)
})
