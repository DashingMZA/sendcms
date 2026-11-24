/**
 * Which OAuth providers are configured (have client ID + secret in env).
 * Every provider — Google included — appears only when its credentials
 * are set, so the sign-in/sign-up UI never offers a provider that
 * would fail. Google is the baseline provider in the sense that it is
 * the one operators are expected to configure first, not in the sense
 * that it is always listed: with no credentials set, no OAuth button
 * renders. Pure env reading — no imports — so server components and
 * unit tests can both use it.
 */
export type OAuthProviderId = "google" | "github" | "facebook"

export function getConfiguredOAuthProviders(): OAuthProviderId[] {
  const providers: OAuthProviderId[] = []
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.push("google")
  }
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    providers.push("github")
  }
  if (process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET) {
    providers.push("facebook")
  }
  return providers
}
