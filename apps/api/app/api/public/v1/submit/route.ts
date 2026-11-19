import { NextRequest, NextResponse, after } from "next/server"
import { processEmailOutbox } from "@sendcms/notifications"
import { notificationDeps } from "@sendcms/email"
import { submitForm } from "@sendcms/submissions"
import {
  ApiError,
  getEffectiveOrigin,
  handleApiError,
} from "@sendcms/api-client"
import {
  SubmitBodySchema,
  formDataToSubmitBody,
} from "@sendcms/submissions/validators"

// Public submission API — no session, no cookies. Authorization is the
// Origin allowlist (enforced in the service): the submitting site must be
// a VERIFIED domain linked to the form. CORS headers are only echoed for
// origins that passed that check, so a rejected origin cannot read the
// response — including error responses.
//
// Two content types are accepted:
//   - application/json (the SDK and direct REST clients)
//   - application/x-www-form-urlencoded / multipart/form-data (a native
//     <form action="…/submit" method="POST"> with no JavaScript). For
//     form posts the response is a 303 redirect instead of JSON: success
//     goes to the form's redirectUrl, else the referring page with
//     ?cms_submitted=1; errors go to the referring page with
//     ?cms_error=<message> (JSON when there is no referer to go back to).

function publicCorsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  }
}

function getClientIp(req: NextRequest): string | null {
  // In production the platform (Cloudflare / Vercel) sets these; the
  // first x-forwarded-for entry is the client. Never trust a later entry.
  const forwarded = req.headers.get("x-forwarded-for")
  if (forwarded) return forwarded.split(",")[0].trim() || null
  return (
    req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? null
  )
}

export async function OPTIONS(req: NextRequest) {
  // Preflight carries no body, so the form is unknown here — the real
  // check happens on POST. Echoing the origin in a preflight grants
  // nothing: it carries no data, and POST still enforces the allowlist.
  const origin = getEffectiveOrigin(req) ?? "*"
  return new NextResponse(null, {
    status: 204,
    headers: publicCorsHeaders(origin),
  })
}

export async function POST(req: NextRequest) {
  const origin = getEffectiveOrigin(req)
  const referer = req.headers.get("referer")
  const contentType = req.headers.get("content-type") ?? ""
  const isFormPost =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  try {
    // Cheap size guard before parsing: the service also caps the
    // sanitized payload after validation.
    const contentLength = req.headers.get("content-length")
    if (contentLength && Number(contentLength) > 64_000) {
      throw new ApiError("Submission is too large.", 413)
    }

    const rawBody = isFormPost
      ? formDataToSubmitBody(await req.formData())
      : await req.json().catch(() => ({}))
    // A no-JS form has no pageUrl field; the referer is the page it
    // was submitted from.
    if (
      isFormPost &&
      typeof rawBody === "object" &&
      rawBody !== null &&
      !("pageUrl" in rawBody) &&
      referer
    ) {
      ;(rawBody as Record<string, unknown>).pageUrl = referer
    }
    const parsed = SubmitBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      const flat = parsed.error.flatten()
      const messages = [
        ...flat.formErrors,
        ...Object.values(flat.fieldErrors).flat(),
      ].filter(Boolean)
      throw new ApiError(messages.join("; ") || "Validation failed", 422)
    }

    const result = await submitForm(parsed.data, {
      origin,
      ip: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
    })

    if (result.kind === "created") {
      // Notifications are already queued (the service enqueues after
      // the durable save). Attempt delivery now, after the response is
      // sent — failures stay queued for the cron worker to retry.
      after(async () => {
        try {
          await processEmailOutbox(notificationDeps, { limit: 25 })
        } catch (err) {
          console.error("[notifications] outbox run failed:", err)
        }
      })
    }

    if (isFormPost) {
      const target =
        result.redirectUrl ?? withQuery(referer, "cms_submitted", "1")
      if (target) {
        return NextResponse.redirect(target, { status: 303 })
      }
      // No referer and no redirectUrl: fall through to JSON.
    }

    const headers = origin ? publicCorsHeaders(origin) : undefined
    const payload = {
      ok: true,
      id: result.kind === "honeypot" ? result.fakeId : result.submission.id,
      message: result.message,
      redirectUrl: result.redirectUrl,
    }
    return NextResponse.json(payload, {
      status: result.kind === "duplicate" ? 200 : 201,
      headers,
    })
  } catch (err) {
    // A form post that fails goes back to the page it came from with
    // the error in the query string (JSON only when there is nowhere
    // to go back to).
    if (isFormPost && referer) {
      const message =
        err instanceof ApiError ? err.message : "Internal server error"
      const target = withQuery(referer, "cms_error", message)
      if (target) {
        return NextResponse.redirect(target, { status: 303 })
      }
    }
    // Only echo CORS headers when the service confirmed the origin is
    // allowed; otherwise the browser cannot read the error at all.
    // Errors use the same public CORS headers as successes (not the
    // legacy admin corsHeaders — this endpoint has no GET/PATCH and
    // takes no Authorization header).
    const allowedOrigin =
      err instanceof ApiError && err.originAllowed && origin
        ? origin
        : undefined
    return handleApiError(
      err,
      undefined,
      allowedOrigin ? publicCorsHeaders(allowedOrigin) : undefined
    )
  }
}

/** Returns url with one query param set, or null when the url is not
    a parseable absolute URL. */
function withQuery(
  url: string | null,
  key: string,
  value: string
): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    parsed.searchParams.set(key, value)
    return parsed.toString()
  } catch {
    return null
  }
}
