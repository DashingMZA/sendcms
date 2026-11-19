/**
 * Types for the plain-JS headers module (`./headers.mjs`) — the `.mjs`
 * file is the runtime source of truth (see its header comment), this
 * declaration only gives TypeScript the shapes so `src/index.ts` and
 * the tests can import it.
 */
export declare function securityHeaders(): {
  source: string
  headers: { key: string; value: string }[]
}[]

export declare function renderHeadersFile(): string
