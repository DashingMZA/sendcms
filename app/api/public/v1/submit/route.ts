import { NextRequest, NextResponse } from "next/server"
import { getEffectiveOrigin } from "@/lib/cors"
import { ApiError, handleApiError } from "@/lib/api/error"
import { SubmitBodySchema } from "@/lib/validators/submission"
import { submitForm } from "@/lib/services/submission-service"

// Public submission API — no session, no cookies. Authorization is the
// Origin allowlist (enforced in the service): the submitting site must be
// a VERIFIED domain linked to the form. CORS headers are only echoed for
// origins that passed that check, so a rejected origin cannot read the
// response — including error responses.

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
  try {
    // Cheap size guard before parsing: the service also caps the
    // sanitized payload after validation.
    const contentLength = req.headers.get("content-length")
    if (contentLength && Number(contentLength) > 64_000) {
      throw new ApiError("Submission is too large.", 413)
    }

    const body = await req.json().catch(() => ({}))
    const parsed = SubmitBodySchema.safeParse(body)
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
