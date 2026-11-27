// TST-007 (Phase 16, Wave 11, Stream C): create (or reuse) the E2E
// user for the Playwright journey, then mark the email verified.
//
// Email/password sign-in is refused while the email is unverified, and
// the seeded demo user (`demo@example.com`) has no password, so the
// journey cannot use it directly. This script signs the user up through
// the api app's Better Auth endpoint (so the password hash is created
// the same way a real sign-up creates it) and then flips
// `emailVerified` in the database — the same two steps a human would
// do, minus waiting for a mailbox.
//
// Usage (DATABASE_URL must point at the SCRATCH database — never the
// shared dev database or production):
//   E2E_USER_EMAIL=e2e@example.com E2E_USER_PASSWORD='<secret>' \
//     DATABASE_URL=postgresql://… pnpm e2e:setup
// Re-running is safe: an already-registered email is left alone (the
// existing password is kept) and only the verified flag is ensured.
import { db } from "@sendcms/database"

const apiUrl = process.env.E2E_API_URL ?? "http://localhost:3001"
const email = process.env.E2E_USER_EMAIL
const password = process.env.E2E_USER_PASSWORD

if (!email || !password) {
  throw new Error(
    "E2E_USER_EMAIL and E2E_USER_PASSWORD must be set — see e2e/README.md"
  )
}

const res = await fetch(`${apiUrl}/api/auth/sign-up/email`, {
  method: "POST",
  // Better Auth rejects cross-origin auth calls without an Origin
  // header (403 MISSING_OR_NULL_ORIGIN); the dashboard origin is in
  // the api's TRUSTED_ORIGINS, so send it.
  headers: {
    "content-type": "application/json",
    origin: process.env.E2E_ORIGIN ?? "http://localhost:3132",
  },
  body: JSON.stringify({ email, password, name: "E2E User" }),
})

if (res.ok) {
  console.log(`Signed up ${email} via ${apiUrl}`)
} else {
  const body = await res.text()
  // Better Auth returns 422 when the email is already registered; that
  // is the expected re-run case — keep the existing password.
  if (res.status === 422 && /already|exists/i.test(body)) {
    console.log(`${email} already registered — reusing existing password`)
  } else {
    throw new Error(`Sign-up failed (${res.status}): ${body.slice(0, 300)}`)
  }
}

const user = await db.user.update({
  where: { email },
  data: { emailVerified: true },
})
console.log(`E2E user ready: ${user.email} (verified=${user.emailVerified})`)
