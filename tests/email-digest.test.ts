// Digest email rendering (Phase 12, Step 3): the real template, not
// a mock — a broken template would send a broken digest, so this pins
// the html + text output for a sample payload.
import { describe, expect, it } from "vitest"
import { notificationDeps } from "@sendcms/email"

const PROPS = {
  formName: "Contact us",
  count: 2,
  summary: "Two customers asked about orders and shipping.",
  highlights: ["Ali needs help with an order."],
  items: [
    {
      senderName: "Ali",
      snippet: "I need help with my order.",
      receivedAt: new Date("2026-11-20T10:00:00Z"),
    },
    {
      senderName: "Sara",
      snippet: "Do you ship to Lahore?",
      receivedAt: new Date("2026-11-20T11:00:00Z"),
    },
  ],
  inboxUrl: "http://localhost:3002/dashboard/inbox?formId=form-1",
  accentColor: "#0891b2",
  footerText: "You're receiving this because you get digests for this form.",
}

describe("renderDigest", () => {
  it("renders the summary, highlights, and items in html and text", async () => {
    const { html, text } = await notificationDeps.renderDigest(PROPS)
    expect(html).toContain("Two customers asked about orders and shipping.")
    expect(html).toContain("Ali needs help with an order.")
    expect(html).toContain("Do you ship to Lahore?")
    expect(html).toContain("2 new submissions on Contact us")
    expect(text).toContain("Two customers asked about orders and shipping.")
    expect(text).toContain("- Ali needs help with an order.")
    expect(text).toContain("View in your inbox:")
  })

  it("uses the singular form for one submission", async () => {
    const { html, text } = await notificationDeps.renderDigest({
      ...PROPS,
      count: 1,
      items: PROPS.items.slice(0, 1),
    })
    expect(html).toContain("1 new submission on Contact us")
    expect(text).toContain("1 new submission on Contact us")
  })
})
