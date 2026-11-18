import { afterEach, describe, expect, it } from "vitest"
import { getConfiguredOAuthProviders } from "@sendcms/auth"

const ENV_KEYS = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "FACEBOOK_CLIENT_ID",
  "FACEBOOK_CLIENT_SECRET",
] as const

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

describe("getConfiguredOAuthProviders", () => {
  it("always lists google", () => {
    expect(getConfiguredOAuthProviders()).toEqual(["google"])
  })

  it("adds github only when both id and secret are set", () => {
    process.env.GITHUB_CLIENT_ID = "id"
    expect(getConfiguredOAuthProviders()).toEqual(["google"])
    process.env.GITHUB_CLIENT_SECRET = "secret"
    expect(getConfiguredOAuthProviders()).toEqual(["google", "github"])
  })

  it("adds facebook only when both id and secret are set", () => {
    process.env.FACEBOOK_CLIENT_ID = "id"
    process.env.FACEBOOK_CLIENT_SECRET = "secret"
    expect(getConfiguredOAuthProviders()).toEqual(["google", "facebook"])
  })

  it("lists all three when all are configured", () => {
    process.env.GITHUB_CLIENT_ID = "id"
    process.env.GITHUB_CLIENT_SECRET = "secret"
    process.env.FACEBOOK_CLIENT_ID = "id"
    process.env.FACEBOOK_CLIENT_SECRET = "secret"
    expect(getConfiguredOAuthProviders()).toEqual([
      "google",
      "github",
      "facebook",
    ])
  })
})
