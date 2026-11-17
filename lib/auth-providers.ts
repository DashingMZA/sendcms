/**
 * Which OAuth providers are configured (have client ID + secret in env).
 * Google is the baseline provider and is always listed; GitHub/Facebook
 * only appear when their credentials are set, so the sign-in/sign-up UI
 * never offers a provider that would fail. Pure env reading — no imports —
 * so server components and unit tests can both use it.
 */
export type OAuthProviderId = "google" | "github" | "facebook"

export function getConfiguredOAuthProviders(): OAuthProviderId[] {
  const providers: OAuthProviderId[] = ["google"]
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    providers.push("github")
  }
  if (process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET) {
    providers.push("facebook")
  }
  return providers
}
