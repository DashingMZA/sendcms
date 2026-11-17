import { describe, expect, it } from "vitest"
import { platformCan, PLATFORM_ROUTE_CAPABILITY } from "@/lib/permissions"
import { siteCan, SETTINGS_SECTION_CAPABILITY } from "@/lib/permissions"

describe("platformCan", () => {
  it("grants the owner every platform capability", () => {
    for (const cap of Object.values(PLATFORM_ROUTE_CAPABILITY)) {
      expect(platformCan("PLATFORM_OWNER", cap)).toBe(true)
    }
  })

  it("grants a plain platform user no platform capability", () => {
    for (const cap of Object.values(PLATFORM_ROUTE_CAPABILITY)) {
      expect(platformCan("PLATFORM_USER", cap)).toBe(false)
    }
  })
})

describe("siteCan", () => {
  it("grants the site owner every capability", () => {
    const all = [
      "MODERATE",
      "MANAGE_SETTINGS",
      "MANAGE_EMAIL_SETTINGS",
      "MANAGE_MODERATORS",
      "MANAGE_ADMINS",
      "DELETE_SITE",
      "TRANSFER_SITE",
    ] as const
    for (const cap of all) expect(siteCan("SITE_OWNER", cap)).toBe(true)
  })

  it("limits admins to moderate + settings + moderators", () => {
    expect(siteCan("SITE_ADMIN", "MODERATE")).toBe(true)
    expect(siteCan("SITE_ADMIN", "MANAGE_SETTINGS")).toBe(true)
    expect(siteCan("SITE_ADMIN", "MANAGE_MODERATORS")).toBe(true)
    expect(siteCan("SITE_ADMIN", "DELETE_SITE")).toBe(false)
    expect(siteCan("SITE_ADMIN", "TRANSFER_SITE")).toBe(false)
    expect(siteCan("SITE_ADMIN", "MANAGE_ADMINS")).toBe(false)
  })

  it("limits moderators to moderation only", () => {
    expect(siteCan("SITE_MODERATOR", "MODERATE")).toBe(true)
    expect(siteCan("SITE_MODERATOR", "MANAGE_SETTINGS")).toBe(false)
  })
})

describe("settings sections", () => {
  it("gates transfer/email/danger behind owner-only capabilities", () => {
    expect(SETTINGS_SECTION_CAPABILITY.transfer).toBe("TRANSFER_SITE")
    expect(SETTINGS_SECTION_CAPABILITY.email).toBe("MANAGE_EMAIL_SETTINGS")
    expect(SETTINGS_SECTION_CAPABILITY.danger).toBe("DELETE_SITE")
  })
})
