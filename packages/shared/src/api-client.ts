export class ApiClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown
  ) {
    super(message)
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  // SRC-316: a hung API route used to hang the dashboard query
  // indefinitely (no timeout), and a 200 with an empty or non-JSON
  // body threw a raw SyntaxError instead of ApiClientError. Both
  // failure modes now surface as ApiClientError, the documented
  // contract the global onError toast handling expects.
  const timeout = AbortSignal.timeout(30_000)
  let res: Response
  try {
    res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...init,
      // The 30 s timeout always applies; a caller-provided signal
      // aborts in addition to it, never instead of it.
      signal: init?.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
    })
  } catch (err) {
    // A timeout abort surfaces as ApiClientError like every other
    // apiFetch failure; a caller-initiated abort still propagates
    // as-is.
    if (timeout.aborted) throw new ApiClientError("Request timed out", 408)
    throw err
  }

  if (!res.ok) {
    // `Response.json()` is `unknown` here — the Node fetch types
    // (@types/node, undici) win over the DOM lib in app programs —
    // so narrow the parsed body explicitly instead of relying on
    // the DOM lib's `any`.
    const body = (await res.json().catch(() => ({}))) as {
      error?: unknown
    }
    const message =
      typeof body.error === "string" ? body.error : "Request failed"
    throw new ApiClientError(message, res.status, body.error)
  }

  if (res.status === 204) return undefined as T
  return res.json().catch(() => {
    throw new ApiClientError("Invalid response", res.status)
  }) as Promise<T>
}
