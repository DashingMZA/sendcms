export class ApiError extends Error {
  // Set by services that know whether the request origin passed the
  // allowlist (public API) — the route only echoes CORS headers for
  // allowed origins, so a rejected origin cannot read the response.
  originAllowed?: boolean

  constructor(
    public readonly message: string,
    public readonly status: number = 400
  ) {
    super(message)
  }
}
