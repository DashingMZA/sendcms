import { afterEach, describe, expect, it } from "vitest"
import { verificationUrlOnDashboard } from "@sendcms/auth"

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DASHBOARD_URL
})

describe("verificationUrlOnDashboard", () => {
  it("rewrites an api-origin verification link to the dashboard origin", () => {
    process.env.NEXT_PUBLIC_DASHBOARD_URL = "https://dashboard.sendcms.bond"
    expect(
      verificationUrlOnDashboard(
        "https://api.sendcms.bond/verify-email?token=abc&callbackURL=%2Fdashboard"
      )
    ).toBe(
      "https://dashboard.sendcms.bond/verify-email?token=abc&callbackURL=%2Fdashboard"
    )
  })

  it("strips the /api/auth mount prefix Better Auth builds the link with", () => {
    process.env.NEXT_PUBLIC_DASHBOARD_URL = "https://dashboard.sendcms.bond"
    expect(
      verificationUrlOnDashboard(
        "https://api.sendcms.bond/api/auth/verify-email?token=abc&callbackURL=%2F"
      )
    ).toBe(
      "https://dashboard.sendcms.bond/verify-email?token=abc&callbackURL=%2F"
    )
  })

  it("falls back to localhost:3002 when no dashboard URL is configured", () => {
    expect(
      verificationUrlOnDashboard(
        "http://localhost:3001/api/auth/verify-email?token=abc&callbackURL=%2Fdashboard"
      )
    ).toBe(
      "http://localhost:3002/verify-email?token=abc&callbackURL=%2Fdashboard"
    )
  })

  it("returns the input unchanged when it is not a URL", () => {
    expect(verificationUrlOnDashboard("not-a-url")).toBe("not-a-url")
  })
})
