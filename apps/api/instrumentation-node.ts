// Node-only startup checks, dynamically imported from
// instrumentation.ts — never loaded in the Edge runtime.
//
// SDK-016: a form with Turnstile on and no server secret can never
// accept a submission (every submit 503s), so an unset
// TURNSTILE_SECRET_KEY with Turnstile-enabled forms is a loud error
// at boot, not a silent per-submit failure. The check is best-effort:
// it never crashes boot (a DB blip at startup only warns).
import { createLogger } from "@sendcms/observability"
import { db } from "@sendcms/database"

const logger = createLogger("api-startup")

export async function runStartupChecks(): Promise<void> {
  try {
    if (process.env.TURNSTILE_SECRET_KEY) return
    const count = await db.form.count({
      where: { turnstileEnabled: true, deletedAt: null },
    })
    if (count > 0) {
      logger.error(
        `Turnstile is enabled on ${count} form(s) but TURNSTILE_SECRET_KEY is unset — every submission to those forms will be rejected (503). Set the secret on the API server or turn Turnstile off.`
      )
    }
  } catch (err) {
    // A failed startup check must never crash boot.
    logger.warn("turnstile startup check failed", { error: err })
  }
}
