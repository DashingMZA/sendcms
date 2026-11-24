import { createLogger } from "@sendcms/observability"

const logger = createLogger("csp-report")

export const dynamic = "force-dynamic"

// CSP violation reports (Phase 16, SRC-318): every app's enforcing
// policy carries `report-uri <api origin>/api/csp-report`, so a
// browser that blocks something under the policy POSTs the violation
// here instead of dropping it silently. The route only logs — it
// never touches the database and never requires auth (browsers send
// reports without credentials), so a flood of reports costs one log
// line each and nothing else. The body is capped and parsed
// leniently: a malformed report is still a 204, never a 500.
const MAX_REPORT_BYTES = 16_384

export async function POST(req: Request) {
  try {
    const raw = await req.text()
    const text =
      raw.length > MAX_REPORT_BYTES ? raw.slice(0, MAX_REPORT_BYTES) : raw
    let report: unknown = null
    try {
      report = text ? JSON.parse(text) : null
    } catch {
      report = { unparsed: text.slice(0, 200) }
    }
    const body =
      report !== null && typeof report === "object" && !Array.isArray(report)
        ? (report as Record<string, unknown>)
        : { report }
    // The classic `report-uri` shape nests the fields under
    // `csp-report`; the newer Reporting API shape sends them flat.
    const csp =
      body["csp-report"] !== null &&
      typeof body["csp-report"] === "object" &&
      !Array.isArray(body["csp-report"])
        ? (body["csp-report"] as Record<string, unknown>)
        : body
    logger.warn("csp violation", {
      documentUri: csp["document-uri"],
      blockedUri: csp["blocked-uri"],
      violatedDirective: csp["violated-directive"],
      effectiveDirective: csp["effective-directive"],
      originalPolicy: csp["original-policy"],
      sourceFile: csp["source-file"],
      lineNumber: csp["line-number"],
    })
  } catch (err) {
    // Reporting must never fail the browser's report (or the request
    // that triggered it): log and still answer 204.
    logger.error("csp report failed", { error: err })
  }
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  })
}
