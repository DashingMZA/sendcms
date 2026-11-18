import { describe, expect, it } from "vitest"
import {
  platformCan,
  PLATFORM_ROUTE_CAPABILITY,
  type PlatformCapability,
} from "@/lib/permissions"

describe("platformCan", () => {
  it("gates no dashboard route anymore (comment system removed)", () => {
    expect(Object.keys(PLATFORM_ROUTE_CAPABILITY)).toHaveLength(0)
  })

  it("grants the owner every platform capability", () => {
    const all: PlatformCapability[] = [
      "VIEW_NOTICE_BOARD",
      "VIEW_ADMINISTRATION",
      "MANAGE_PLATFORM_SETTINGS",
    ]
    for (const cap of all) expect(platformCan("PLATFORM_OWNER", cap)).toBe(true)
  })

  it("grants a plain platform user no platform capability", () => {
    const all: PlatformCapability[] = [
      "VIEW_NOTICE_BOARD",
      "VIEW_ADMINISTRATION",
      "MANAGE_PLATFORM_SETTINGS",
    ]
    for (const cap of all) expect(platformCan("PLATFORM_USER", cap)).toBe(false)
  })
})
